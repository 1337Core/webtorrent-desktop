import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bencode from 'bencode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_IMPORT_LIMITS } from './legacy-import'
import { LegacyImportService } from './legacy-import-service'
import { EgressPolicy } from './network-policy'

let root = ''
let service: LegacyImportService
let now = 1_000

function torrentBytes(name: string): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    info: {
      files: [
        { length: 10, path: ['first.bin'] },
        { length: 10, path: ['second.bin'] }
      ],
      name,
      'piece length': 16_384,
      pieces: new Uint8Array(20)
    }
  })
}

async function writeProfile(count: number): Promise<void> {
  await mkdir(path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory), {
    recursive: true
  })
  const torrents: Array<Record<string, unknown>> = []
  for (let index = 0; index < count; index += 1) {
    const fileName = `torrent-${index}.torrent`
    await writeFile(
      path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory, fileName),
      torrentBytes(`payload-${index}`)
    )
    torrents.push({
      displayName: `Legacy ${index}`,
      selections: [true, false],
      torrentFileName: fileName
    })
  }
  torrents.push({ displayName: 'Broken', torrentFileName: 'absent.torrent' })
  await writeFile(
    path.join(root, LEGACY_IMPORT_LIMITS.stateFile),
    JSON.stringify({ torrents, version: '0.24.0' })
  )
}

beforeEach(async () => {
  now = 1_000
  root = await mkdtemp(path.join(tmpdir(), 'wu-legacy-service-'))
  service = new LegacyImportService({
    now: () => now,
    policy: new EgressPolicy()
  })
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('LegacyImportService', () => {
  it('pages scanned entries with a stable cursor', async () => {
    await writeProfile(3)

    const first = await service.page(root, 0, 2)
    expect(first.total).toBe(4)
    expect(first.skippedCount).toBe(1)
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(2)
    expect(first.items[0]).toMatchObject({
      fileCount: 2,
      kind: 'importable',
      name: 'Legacy 0',
      private: false,
      selectedFileCount: 1
    })

    const second = await service.page(root, first.nextCursor ?? 0, 64)
    expect(second.items.at(-1)).toEqual({
      kind: 'skipped',
      name: 'Broken',
      reason: 'TORRENT_FILE_MISSING'
    })
    expect(second.nextCursor).toBeNull()
  })

  it('hands an importable entry over exactly once', async () => {
    await writeProfile(1)
    const page = await service.page(root, 0, 64)
    const entry = page.items[0]
    if (!entry || entry.kind !== 'importable') {
      throw new Error('Expected an importable entry')
    }

    const candidate = await service.take(root, entry.infoHash)
    expect(candidate?.selectedIndexes).toEqual([0])
    expect(candidate?.metadata.infoHash).toBe(entry.infoHash)

    expect(await service.take(root, entry.infoHash)).toBeNull()
    const after = await service.page(root, 0, 64)
    expect(after.items[0]).toMatchObject({
      kind: 'skipped',
      reason: 'DUPLICATE'
    })
  })

  it('refuses an unknown info hash', async () => {
    await writeProfile(1)
    expect(await service.take(root, 'f'.repeat(40))).toBeNull()
  })

  it('rescans after the cache expires', async () => {
    await writeProfile(1)
    const page = await service.page(root, 0, 64)
    const entry = page.items[0]
    if (!entry || entry.kind !== 'importable') {
      throw new Error('Expected an importable entry')
    }
    await service.take(root, entry.infoHash)

    now += 16 * 60_000
    const rescanned = await service.page(root, 0, 64)
    expect(rescanned.items[0]).toMatchObject({ kind: 'importable' })

    service.forget(root)
    expect((await service.page(root, 0, 64)).total).toBe(2)
  })

  it('reports an unreadable profile through the importer error', async () => {
    await expect(service.page(root, 0, 64)).rejects.toMatchObject({
      code: 'STATE_UNREADABLE'
    })
  })
})
