import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TORRENT_ARCHIVE_LIMITS,
  TorrentArchive,
  TorrentArchiveError
} from './torrent-archive'
import { TORRENT_METADATA_LIMITS } from './torrent-metadata'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'torrent-archive-'))
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

describe('TorrentArchive', () => {
  it('stores and returns the exact bytes it was given', async () => {
    const archive = new TorrentArchive({ directory })
    const bytes = new Uint8Array([1, 2, 3, 4])

    await archive.save(INFO_HASH, bytes)

    expect(await archive.load(INFO_HASH)).toEqual(bytes)
    const stats = await stat(archive.archivePath(INFO_HASH))
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind', async () => {
    const archive = new TorrentArchive({ directory })
    await archive.save(INFO_HASH, new Uint8Array([9]))

    const entries = await readFile(archive.archivePath(INFO_HASH))
    expect(entries.byteLength).toBe(1)
  })

  it('refuses an info hash that is not a v1 hash', () => {
    const archive = new TorrentArchive({ directory })

    expect(() => archive.archivePath('../escape')).toThrow(TorrentArchiveError)
  })

  it('refuses empty and oversized bytes', async () => {
    const archive = new TorrentArchive({ directory })

    await expect(archive.save(INFO_HASH, new Uint8Array())).rejects.toThrow(
      TorrentArchiveError
    )
    await expect(
      archive.save(
        INFO_HASH,
        new Uint8Array(TORRENT_ARCHIVE_LIMITS.maxTorrentBytes + 1)
      )
    ).rejects.toThrow(TorrentArchiveError)
  })

  it('reads an absent or oversized archive as absent', async () => {
    const archive = new TorrentArchive({ directory })
    expect(await archive.load(INFO_HASH)).toBeNull()

    await writeFile(
      archive.archivePath(INFO_HASH),
      Buffer.alloc(TORRENT_ARCHIVE_LIMITS.maxTorrentBytes + 1)
    )
    expect(await archive.load(INFO_HASH)).toBeNull()
  })

  it('archives and exports the metadata boundary’s largest accepted payload', async () => {
    const archive = new TorrentArchive({ directory })
    const bytes = new Uint8Array(TORRENT_METADATA_LIMITS.bytes)
    const destination = path.join(directory, 'maximum.torrent')

    expect(TORRENT_ARCHIVE_LIMITS.maxTorrentBytes).toBe(
      TORRENT_METADATA_LIMITS.bytes
    )
    await archive.save(INFO_HASH, bytes)
    await expect(archive.export(INFO_HASH, destination)).resolves.toBe(true)
    expect((await stat(destination)).size).toBe(TORRENT_METADATA_LIMITS.bytes)
  })

  it('atomically exports the exact archived bytes', async () => {
    const archive = new TorrentArchive({ directory })
    const bytes = new Uint8Array([4, 3, 2, 1])
    const destination = path.join(directory, 'shared.torrent')
    await archive.save(INFO_HASH, bytes)
    await writeFile(destination, new Uint8Array([9]))

    await expect(archive.export(INFO_HASH, destination)).resolves.toBe(true)

    expect(await readFile(destination)).toEqual(Buffer.from(bytes))
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
    expect(
      (await readdir(directory)).filter(entry => entry.endsWith('.tmp'))
    ).toEqual([])
  })

  it('reports a missing archive without creating an export', async () => {
    const archive = new TorrentArchive({ directory })
    const destination = path.join(directory, 'missing.torrent')

    await expect(archive.export(INFO_HASH, destination)).resolves.toBe(false)
    await expect(readFile(destination)).rejects.toThrow()
    await expect(archive.export(INFO_HASH, 'relative.torrent')).rejects.toThrow(
      TorrentArchiveError
    )
  })

  it('removes an archived torrent and tolerates a second removal', async () => {
    const archive = new TorrentArchive({ directory })
    await archive.save(INFO_HASH, new Uint8Array([7]))

    await archive.remove(INFO_HASH)
    await archive.remove(INFO_HASH)

    expect(await archive.load(INFO_HASH)).toBeNull()
  })

  it('requires an absolute directory', () => {
    expect(() => new TorrentArchive({ directory: 'relative' })).toThrow(
      TorrentArchiveError
    )
  })
})
