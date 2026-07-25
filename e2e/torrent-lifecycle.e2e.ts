import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { browser, expect } from '@wdio/globals'

const PIECE_LENGTH = 16_384

/**
 * The fixture torrent is built here rather than imported: the spec runs under
 * the automation loader, and a minimal encoder keeps the sample explicit —
 * one public single-file v1 torrent with no announce.
 */
function bencode(value: unknown): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  }
  if (typeof value === 'string') return bencode(Buffer.from(value, 'utf8'))
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from('l'),
      ...value.map(entry => bencode(entry)),
      Buffer.from('e')
    ])
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
  )
  return Buffer.concat([
    Buffer.from('d'),
    ...entries.flatMap(([key, entry]) => [bencode(key), bencode(entry)]),
    Buffer.from('e')
  ])
}

function buildTorrent(name: string, payload: Buffer): Buffer {
  const hashes: Buffer[] = []
  for (let offset = 0; offset < payload.length; offset += PIECE_LENGTH) {
    hashes.push(
      createHash('sha1')
        .update(payload.subarray(offset, offset + PIECE_LENGTH))
        .digest()
    )
  }
  return bencode({
    info: {
      length: payload.length,
      name,
      'piece length': PIECE_LENGTH,
      pieces: Buffer.concat(hashes)
    }
  })
}

type CommandResult = {
  /** The engine-side failure code, if the command was refused. */
  code: string | null
  ok: boolean
  value: Record<string, unknown> | null
}

/**
 * Runs one engine command through the app's own validated bridge and unwraps
 * the two envelopes the renderer sees: the desktop result and the engine's.
 */
async function run(operation: unknown): Promise<CommandResult> {
  return (await browser.execute(async (payload: unknown) => {
    const desktop = (
      globalThis as unknown as {
        desktop: { runTorrentCommand: (input: unknown) => Promise<unknown> }
      }
    ).desktop
    let outer: Record<string, unknown>
    try {
      outer = (await desktop.runTorrentCommand(payload)) as Record<
        string,
        unknown
      >
    } catch (error) {
      return { code: 'THREW', ok: false, value: null, threw: String(error) }
    }
    if (outer.ok !== true) {
      const error = outer.error as { code?: string } | undefined
      return { code: error?.code ?? null, ok: false, value: null }
    }
    const inner = outer.value as Record<string, unknown>
    if (inner.ok !== true) {
      const error = inner.error as { code?: string } | undefined
      return { code: error?.code ?? null, ok: false, value: null }
    }
    const result = inner.result as { value?: Record<string, unknown> }
    return { code: null, ok: true, value: result.value ?? null }
  }, operation)) as unknown as CommandResult
}

/**
 * The two-phase add is the application's central flow: nothing touches disk
 * until a reviewed preparation is committed. This exercises it end to end in
 * the packaged app, through the same three-method bridge the interface uses.
 */
describe('torrent lifecycle', () => {
  let root = ''
  let torrentPath = ''
  let destinationRoot = ''

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-e2e-'))
    const payloadRoot = path.join(root, 'payload')
    destinationRoot = path.join(root, 'downloads')
    await mkdir(payloadRoot, { recursive: true })
    await mkdir(destinationRoot, { recursive: true })

    const payload = randomBytes(64 * 1024)
    await writeFile(path.join(payloadRoot, 'sample.bin'), payload)
    torrentPath = path.join(root, 'sample.torrent')
    await writeFile(torrentPath, buildTorrent('sample.bin', payload))

    // Commands are refused until the supervised engine reports ready.
    await browser.waitUntil(
      async () =>
        (await browser
          .$('[data-engine-state]')
          .getAttribute('data-engine-state')) === 'ready',
      { timeout: 60_000, timeoutMsg: 'The engine did not become ready' }
    )
  })

  after(async () => {
    if (root) await rm(root, { force: true, recursive: true })
  })

  it('starts with an empty library', async () => {
    const listed = await run({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })

    expect(listed.ok).toBe(true)
    expect(listed.value?.total).toBe(0)
  })

  it('reviews and commits a local torrent, then removes it', async () => {
    const prepared = await run({
      command: 'open-preparation',
      payload: { source: { kind: 'local-torrent', path: torrentPath } }
    })
    expect(prepared.ok).toBe(true)
    const preparationId = prepared.value?.preparationId as string
    expect(typeof preparationId).toBe('string')

    // Reviewing a preparation must not create the destination content.
    const files = await run({
      command: 'get-preparation-files',
      payload: { preparationId, cursor: 0, limit: 50 }
    })
    expect(files.ok).toBe(true)

    const committed = await run({
      command: 'commit-preparation',
      payload: { preparationId, destinationRoot }
    })
    expect(committed.ok).toBe(true)
    const torrent = committed.value?.torrent as
      { infoHash?: string; name?: string } | undefined
    expect(typeof torrent?.infoHash).toBe('string')

    const listed = await run({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })
    expect(listed.value?.total).toBe(1)

    // The committed torrent appears in the interface without a reload.
    await expect(browser.$('.torrent-list')).toBeExisting()

    const removed = await run({
      command: 'remove-torrent',
      payload: { deleteData: false, infoHash: torrent?.infoHash }
    })
    expect(removed.ok).toBe(true)

    const empty = await run({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })
    expect(empty.value?.total).toBe(0)
  })

  it('refuses a preparation source outside the validated shapes', async () => {
    const refused = await run({
      command: 'open-preparation',
      payload: { source: { kind: 'local-torrent', path: 'relative.torrent' } }
    })

    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('INVALID_REQUEST')
  })
})
