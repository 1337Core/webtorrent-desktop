import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { browser, expect } from '@wdio/globals'

const PIECE_LENGTH = 16_384

/** The same minimal encoder the lifecycle spec uses, for one v1 fixture. */
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

function legacyTorrent(): { bytes: Buffer; infoHash: string } {
  const info = {
    files: [
      { length: 8, path: ['first.bin'] },
      { length: 8, path: ['second.bin'] }
    ],
    name: 'legacy-payload',
    'piece length': PIECE_LENGTH,
    pieces: Buffer.alloc(20)
  }
  return {
    bytes: bencode({ announce: 'https://tracker.example/announce', info }),
    infoHash: createHash('sha1').update(bencode(info)).digest('hex')
  }
}

type CommandResult = {
  code: string | null
  ok: boolean
  value: Record<string, unknown> | null
}

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
 * Legacy import must be read-only. The v1 profile a real owner would still
 * have on disk is the one thing this migration must never damage, so the
 * packaged app is measured against an untouched fixture profile.
 */
describe('legacy import', () => {
  let root = ''
  let legacyRoot = ''
  let destinationRoot = ''
  let infoHash = ''
  let profileBefore: string[] = []
  let torrentBefore = Buffer.alloc(0)

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-e2e-'))
    legacyRoot = path.join(root, 'legacy')
    destinationRoot = path.join(root, 'downloads')
    await mkdir(path.join(legacyRoot, 'Torrents'), { recursive: true })
    await mkdir(destinationRoot, { recursive: true })

    const fixture = legacyTorrent()
    infoHash = fixture.infoHash
    await writeFile(
      path.join(legacyRoot, 'Torrents', 'one.torrent'),
      fixture.bytes
    )
    await writeFile(
      path.join(legacyRoot, 'config.json'),
      JSON.stringify({
        prefs: { downloadPath: destinationRoot },
        torrents: [
          {
            displayName: 'Legacy One',
            selections: [false, true],
            torrentFileName: 'one.torrent'
          }
        ],
        version: '0.24.0'
      })
    )
    profileBefore = (await readdir(legacyRoot)).sort()
    torrentBefore = await readFile(
      path.join(legacyRoot, 'Torrents', 'one.torrent')
    )

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

  it('lists an importable v1 profile without changing it', async () => {
    const listed = await run({
      command: 'list-legacy-imports',
      payload: { cursor: 0, legacyRoot, limit: 50 }
    })

    expect(listed.ok).toBe(true)
    const items = listed.value?.items as ReadonlyArray<{
      infoHash?: string
      kind?: string
    }>
    expect(items).toHaveLength(1)
    expect(items[0]?.infoHash).toBe(infoHash)
    expect(items[0]?.kind).toBe('importable')
  })

  it('imports a torrent and leaves the legacy profile byte-identical', async () => {
    const imported = await run({
      command: 'import-legacy-torrent',
      payload: { destinationRoot, infoHash, legacyRoot }
    })

    expect(imported.ok).toBe(true)
    const torrent = imported.value?.torrent as { infoHash?: string } | undefined
    expect(torrent?.infoHash).toBe(infoHash)

    // The migration reads the v1 profile and writes nothing back to it.
    expect((await readdir(legacyRoot)).sort()).toEqual(profileBefore)
    expect(
      (await readFile(path.join(legacyRoot, 'Torrents', 'one.torrent'))).equals(
        torrentBefore
      )
    ).toBe(true)
  })

  it('refuses a legacy root that is not an absolute path', async () => {
    const refused = await run({
      command: 'list-legacy-imports',
      payload: { cursor: 0, legacyRoot: 'legacy', limit: 50 }
    })

    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('INVALID_REQUEST')
  })
})
