import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { TORRENT_METADATA_LIMITS } from './torrent-metadata'

export const TORRENT_ARCHIVE_LIMITS = {
  /** The same ceiling the metadata boundary accepts for one torrent. */
  maxTorrentBytes: TORRENT_METADATA_LIMITS.bytes
} as const

export type TorrentArchiveErrorCode = 'INVALID_INPUT' | 'IO_FAILED'

export class TorrentArchiveError extends Error {
  readonly code: TorrentArchiveErrorCode

  constructor(code: TorrentArchiveErrorCode) {
    super(`Torrent archive operation failed: ${code}.`)
    this.name = 'TorrentArchiveError'
    this.code = code
  }
}

/**
 * The fork-owned copy of every committed torrent's bytes, kept so a restart
 * can rebuild its sessions without asking the network for metadata again.
 *
 * The archive stores bytes and nothing else. Identity, destination, selection,
 * and status intent live in the main-process state document (section 10.1),
 * and the bytes are revalidated through the ordinary metadata boundary on the
 * way back in.
 */
export class TorrentArchive {
  readonly #directory: string

  constructor(options: Readonly<{ directory: string }>) {
    if (!path.isAbsolute(options.directory)) {
      throw new TorrentArchiveError('INVALID_INPUT')
    }
    this.#directory = path.resolve(options.directory)
  }

  archivePath(infoHash: string): string {
    if (!/^[0-9a-f]{40}$/u.test(infoHash)) {
      throw new TorrentArchiveError('INVALID_INPUT')
    }
    return path.join(this.#directory, `${infoHash}.torrent`)
  }

  /** Atomic: a torn write can never replace good torrent bytes. */
  async save(infoHash: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) {
      throw new TorrentArchiveError('INVALID_INPUT')
    }
    if (bytes.byteLength > TORRENT_ARCHIVE_LIMITS.maxTorrentBytes) {
      throw new TorrentArchiveError('INVALID_INPUT')
    }

    const target = this.archivePath(infoHash)
    const temporary = `${target}.${process.pid}.tmp`
    try {
      await mkdir(this.#directory, { mode: 0o700, recursive: true })
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw new TorrentArchiveError('IO_FAILED')
    }
  }

  /** Absent or oversized bytes read as absent; the caller re-adds by hand. */
  async load(infoHash: string): Promise<Uint8Array | null> {
    let bytes: Buffer
    try {
      bytes = await readFile(this.archivePath(infoHash))
    } catch {
      return null
    }
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > TORRENT_ARCHIVE_LIMITS.maxTorrentBytes
    ) {
      return null
    }
    return new Uint8Array(bytes)
  }

  /**
   * Copies archived bytes to the path main received from its save dialog.
   * The destination is replaced atomically, so a failed write cannot leave a
   * truncated `.torrent` file behind.
   */
  async export(infoHash: string, destinationPath: string): Promise<boolean> {
    if (
      !path.isAbsolute(destinationPath) ||
      path.normalize(destinationPath) !== destinationPath ||
      path.dirname(destinationPath) === destinationPath
    ) {
      throw new TorrentArchiveError('INVALID_INPUT')
    }

    const bytes = await this.load(infoHash)
    if (bytes === null) return false

    const temporary = `${destinationPath}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, destinationPath)
      return true
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw new TorrentArchiveError('IO_FAILED')
    }
  }

  async remove(infoHash: string): Promise<void> {
    await unlink(this.archivePath(infoHash)).catch(() => undefined)
  }
}
