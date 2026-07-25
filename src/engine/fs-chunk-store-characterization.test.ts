import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import FSChunkStore from 'fs-chunk-store'

/**
 * Why the app owns its storage instead of wrapping `fs-chunk-store@5.0.1`.
 *
 * This characterizes the upstream behavior the engine refuses to inherit: a
 * read of a file that was never written still creates that file's directory
 * inside the download root. For a torrent with deselected files that means
 * empty directories the user never asked for, which is why the production
 * store is app-owned and never a wrapper around this one. The paired
 * expectation lives in `guarded-store.test.ts`: the engine's store creates no
 * directory for a read of an absent file.
 *
 * If this test ever fails, the upstream hazard is gone and the decision in
 * plan section 9.9 can be revisited — it is not a regression in this app.
 */
const CHUNK_LENGTH = 8

let root = ''

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-chunk-store-'))
})

afterEach(async () => {
  if (root) await rm(root, { force: true, recursive: true })
})

describe('fs-chunk-store characterization', () => {
  it('creates a deselected file’s directory just to fail a read', async () => {
    const store = new FSChunkStore(CHUNK_LENGTH, {
      files: [
        { length: CHUNK_LENGTH, path: path.join(root, 'wanted', 'a.bin') },
        { length: CHUNK_LENGTH, path: path.join(root, 'skipped', 'b.bin') }
      ]
    }) as unknown as {
      close: (callback: (error?: Error | null) => void) => void
      get: (
        index: number,
        callback: (error: Error | null, chunk?: Uint8Array) => void
      ) => void
      put: (
        index: number,
        chunk: Uint8Array,
        callback: (error?: Error | null) => void
      ) => void
    }

    await new Promise<void>(resolve => {
      store.put(0, new Uint8Array(CHUNK_LENGTH).fill(1), () => resolve())
    })

    const failure = await new Promise<Error | null>(resolve => {
      store.get(1, error => resolve(error))
    })
    expect(failure).toBeInstanceOf(Error)

    // The read failed, and the directory for the never-written file exists
    // anyway. That is the behavior the engine's own store does not reproduce.
    expect(await exists(path.join(root, 'skipped'))).toBe(true)
    expect(await exists(path.join(root, 'skipped', 'b.bin'))).toBe(false)

    await new Promise<void>(resolve => {
      store.close(() => resolve())
    })
  })

  it('is never imported by the engine’s own storage path', async () => {
    const source = await readFile(
      path.join(import.meta.dirname, 'guarded-store.ts'),
      'utf8'
    )
    const imports = source
      .split(/\r?\n/u)
      .filter(line => /^\s*import\b/u.test(line))
      .join('\n')

    // A guard against reintroduction: the production store may describe this
    // package in prose, but it must never load it.
    expect(imports).not.toContain('fs-chunk-store')
  })
})
