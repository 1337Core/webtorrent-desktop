import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ResumeStore,
  ResumeStoreError,
  RESUME_SCHEMA_VERSION,
  type ResumeExpectation
} from './resume-store'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

let root = ''
let directory = ''
let store: ResumeStore
let fingerprints: Map<string, { mtimeMs: number; size: number }>

function expectation(
  overrides: Partial<ResumeExpectation> = {}
): ResumeExpectation {
  return {
    files: [
      { length: 20, path: 'payload/first.bin' },
      { length: 20, path: 'payload/second.bin' }
    ],
    infoHash: INFO_HASH,
    length: 40,
    pieceCount: 3,
    pieceLength: 16,
    root,
    selectedPaths: ['payload/first.bin'],
    ...overrides
  }
}

function bitfield(): Uint8Array {
  return Uint8Array.from([0b1010_0000])
}

async function saveCurrent(cleanShutdown = true): Promise<void> {
  await store.save(
    await store.describe({
      bitfield: bitfield(),
      cleanShutdown,
      expectation: expectation()
    })
  )
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-resume-root-'))
  directory = await mkdtemp(path.join(tmpdir(), 'wu-resume-'))
  fingerprints = new Map([
    [path.resolve(root, 'payload/first.bin'), { mtimeMs: 1_000, size: 20 }],
    [path.resolve(root, 'payload/second.bin'), { mtimeMs: 2_000, size: 20 }]
  ])
  store = new ResumeStore({
    directory,
    statFile: async target => {
      const fingerprint = fingerprints.get(target)
      if (!fingerprint) throw new Error('missing')
      return fingerprint
    }
  })
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
  await rm(directory, { force: true, recursive: true })
})

describe('ResumeStore', () => {
  it('rejects a relative directory and a malformed info hash', () => {
    expect(() => new ResumeStore({ directory: 'relative' })).toThrow(
      ResumeStoreError
    )
    expect(() => store.sidecarPath('not-a-hash')).toThrow(
      expect.objectContaining({ code: 'PATH_NOT_AUTHORIZED' }) as Error
    )
  })

  it('writes an atomic sidecar and reads it back', async () => {
    await saveCurrent()

    const loaded = await store.load(INFO_HASH)
    expect(loaded).toMatchObject({
      cleanShutdown: true,
      fileCount: 2,
      infoHash: INFO_HASH,
      pieceCount: 3,
      schemaVersion: RESUME_SCHEMA_VERSION,
      selectedPaths: ['payload/first.bin']
    })
    expect(loaded?.files).toEqual([
      { length: 20, mtimeMs: 1_000, path: 'payload/first.bin', size: 20 },
      { length: 20, mtimeMs: 2_000, path: 'payload/second.bin', size: 20 }
    ])

    const raw = await readFile(store.sidecarPath(INFO_HASH), 'utf8')
    expect(JSON.parse(raw)).toHaveProperty('checksum')
  })

  it('offers the bitfield only when everything matches', async () => {
    await saveCurrent()

    const decision = await store.evaluate(
      expectation(),
      await store.load(INFO_HASH)
    )
    expect(decision).toEqual({ bitfield: bitfield(), usable: true })
  })

  it('refuses a tampered or truncated sidecar', async () => {
    await saveCurrent()
    const target = store.sidecarPath(INFO_HASH)
    const parsed = JSON.parse(await readFile(target, 'utf8')) as Record<
      string,
      unknown
    >
    parsed.selectedPaths = ['payload/second.bin']
    await writeFile(target, JSON.stringify(parsed))

    expect(await store.load(INFO_HASH)).toBeNull()

    await writeFile(target, '{"schemaVersion":1')
    expect(await store.load(INFO_HASH)).toBeNull()
    expect(await store.load('f'.repeat(40))).toBeNull()
  })

  it('invalidates the whole bitfield when one file changed or vanished', async () => {
    await saveCurrent()
    const sidecar = await store.load(INFO_HASH)

    fingerprints.set(path.resolve(root, 'payload/second.bin'), {
      mtimeMs: 9_999,
      size: 20
    })
    expect(await store.evaluate(expectation(), sidecar)).toEqual({
      reason: 'FILE_CHANGED',
      usable: false
    })

    fingerprints.delete(path.resolve(root, 'payload/second.bin'))
    expect(await store.evaluate(expectation(), sidecar)).toEqual({
      reason: 'FILE_MISSING',
      usable: false
    })
  })

  it('refuses identity, geometry, manifest, and selection drift', async () => {
    await saveCurrent()
    const sidecar = await store.load(INFO_HASH)

    const cases: Array<[Partial<ResumeExpectation>, string]> = [
      [{ infoHash: 'f'.repeat(40) }, 'IDENTITY_MISMATCH'],
      [{ root: path.join(root, 'elsewhere') }, 'IDENTITY_MISMATCH'],
      [{ pieceLength: 32 }, 'GEOMETRY_MISMATCH'],
      [{ pieceCount: 4 }, 'GEOMETRY_MISMATCH'],
      [{ length: 41 }, 'GEOMETRY_MISMATCH'],
      [
        { files: [{ length: 20, path: 'payload/first.bin' }] },
        'MANIFEST_MISMATCH'
      ],
      [
        {
          files: [
            { length: 20, path: 'payload/first.bin' },
            { length: 21, path: 'payload/second.bin' }
          ]
        },
        'MANIFEST_MISMATCH'
      ],
      [{ selectedPaths: [] }, 'SELECTION_MISMATCH']
    ]

    for (const [overrides, reason] of cases) {
      expect(await store.evaluate(expectation(overrides), sidecar)).toEqual({
        reason,
        usable: false
      })
    }
  })

  it('refuses a sidecar written without a clean shutdown', async () => {
    await saveCurrent(false)

    expect(
      await store.evaluate(expectation(), await store.load(INFO_HASH))
    ).toEqual({ reason: 'UNCLEAN_SHUTDOWN', usable: false })
  })

  it('requires a bitfield sized for the piece count', async () => {
    const sidecar = await store.describe({
      bitfield: new Uint8Array(4),
      cleanShutdown: true,
      expectation: expectation()
    })
    await store.save(sidecar)

    expect(
      await store.evaluate(expectation(), await store.load(INFO_HASH))
    ).toEqual({ reason: 'GEOMETRY_MISMATCH', usable: false })
  })

  it('treats an absent sidecar as a full verification', async () => {
    expect(await store.evaluate(expectation(), null)).toEqual({
      reason: 'SCHEMA_MISMATCH',
      usable: false
    })
  })

  it('removes a sidecar idempotently', async () => {
    await saveCurrent()
    await store.remove(INFO_HASH)
    await store.remove(INFO_HASH)
    expect(await store.load(INFO_HASH)).toBeNull()
  })
})
