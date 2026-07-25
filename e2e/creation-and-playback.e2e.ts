import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { browser, expect } from '@wdio/globals'

type CommandResult = {
  code: string | null
  ok: boolean
  value: Record<string, unknown> | null
}

/** Runs one engine command through the app's own validated bridge. */
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
 * Creation, preferences, and playback in the packaged app.
 *
 * Each one is exercised through the capability the interface itself uses, so
 * what passes here is the behavior the owner gets — not a test-only path.
 */
describe('creation, preferences, and playback', () => {
  let root = ''
  let sourceRoot = ''
  let destinationRoot = ''

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-e2e-'))
    sourceRoot = path.join(root, 'source')
    destinationRoot = path.join(root, 'created')
    await mkdir(sourceRoot, { recursive: true })
    await mkdir(destinationRoot, { recursive: true })
    await writeFile(path.join(sourceRoot, 'clip.bin'), randomBytes(96 * 1024))

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

  it('creates a torrent from a chosen source and seeds it', async () => {
    const created = await run({
      command: 'create-torrent',
      payload: {
        allowHttpTrackers: false,
        allowPrivateNetwork: false,
        announceTiers: [],
        destinationRoot,
        filterJunkFiles: true,
        operationId: randomUUID(),
        private: false,
        sourcePath: path.join(sourceRoot, 'clip.bin')
      }
    })

    expect(created.ok).toBe(true)
    const torrent = created.value?.torrent as
      { infoHash?: string; name?: string } | undefined
    expect(torrent?.name).toBe('clip.bin')
    expect(typeof torrent?.infoHash).toBe('string')

    // The created torrent is owned like any other, and creation seeds the
    // source where it already lives: nothing is copied, moved, or added
    // beside it.
    const listed = await run({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })
    expect(listed.value?.total).toBe(1)
    expect(await readdir(sourceRoot)).toEqual(['clip.bin'])
  })

  it('serves a completed file through the loopback proxy only by lease', async () => {
    const listed = await run({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })
    const items = listed.value?.items as ReadonlyArray<{ infoHash: string }>
    const infoHash = items[0]?.infoHash
    if (!infoHash) throw new Error('The created torrent is missing')

    const opened = await run({
      command: 'open-media',
      payload: { fileIndex: 0, infoHash }
    })
    expect(opened.ok).toBe(true)
    const lease = opened.value as { leaseId?: string; url?: string } | undefined
    expect(lease?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u)

    // The lease serves the player's own bounded range request.
    const ranged = await fetch(lease?.url as string, {
      headers: { range: 'bytes=0-1023' }
    })
    expect(ranged.status).toBe(206)
    expect((await ranged.arrayBuffer()).byteLength).toBe(1_024)

    // The renderer cannot read the same URL with a scripted request: the
    // proxy refuses an unexpected Origin, so a lease is not a general-purpose
    // capability handed to page script.
    const scripted = (await browser.execute(async (url: string) => {
      try {
        const response = await fetch(url)
        return `status:${response.status}`
      } catch {
        return 'refused'
      }
    }, lease?.url as string)) as unknown as string
    expect(scripted).not.toBe('status:206')

    const closed = await run({
      command: 'close-media',
      payload: { leaseId: lease?.leaseId }
    })
    expect(closed.ok).toBe(true)

    // A revoked lease is dead: the same URL no longer serves the file.
    const afterClose = await fetch(lease?.url as string)
    expect(afterClose.status).toBe(404)
  })

  it('stores a preference change and reports it in the next bootstrap', async () => {
    const applied = (await browser.execute(async (folder: string) => {
      const desktop = (
        globalThis as unknown as {
          desktop: {
            setPreferences: (update: unknown) => Promise<unknown>
            getBootstrap: () => Promise<unknown>
          }
        }
      ).desktop
      const result = (await desktop.setPreferences({
        torrentsFolder: folder
      })) as { ok?: boolean }
      const bootstrap = (await desktop.getBootstrap()) as {
        value?: { state?: { preferences?: { torrentsFolder?: string | null } } }
      }
      return {
        ok: result.ok === true,
        stored: bootstrap.value?.state?.preferences?.torrentsFolder ?? null
      }
    }, sourceRoot)) as unknown as { ok: boolean; stored: string | null }

    expect(applied.ok).toBe(true)
    expect(applied.stored).toBe(sourceRoot)
  })
})
