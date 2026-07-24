import { constants } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalTorrentReader,
  LOCAL_TORRENT_MAX_BYTES,
  LocalTorrentReadError,
  readLocalTorrentFile
} from './local-torrent-reader'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wtu-local-reader-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async directory => {
      await rm(directory, { force: true, recursive: true })
    })
  )
})

function fakeStat(
  size: number,
  regular = true
): Readonly<{ isFile: () => boolean; size: number }> {
  return {
    isFile: () => regular,
    size
  }
}

describe('readLocalTorrentFile', () => {
  it('reads a regular file through a bounded read-only descriptor', async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, 'example.torrent')
    const expected = new TextEncoder().encode('d4:infod4:name4:testee')
    await writeFile(filePath, expected)

    await expect(readLocalTorrentFile(filePath)).resolves.toEqual(expected)
  })

  it('opens with O_NOFOLLOW and nonblocking read-only access', async () => {
    let observedFlags = -1
    const close = vi.fn(async () => undefined)
    const reader = createLocalTorrentReader(async (_filePath, flags) => {
      observedFlags = flags
      return {
        close,
        read: vi.fn(async () => ({ bytesRead: 0 })),
        stat: vi.fn(async () => fakeStat(0))
      }
    })

    await reader('/already/authorized/example.torrent')

    expect(observedFlags & (constants.O_WRONLY | constants.O_RDWR)).toBe(
      constants.O_RDONLY
    )
    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(observedFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not follow a symlink in the final path component', async () => {
    const directory = await temporaryDirectory()
    const targetPath = path.join(directory, 'target.torrent')
    const linkPath = path.join(directory, 'link.torrent')
    await writeFile(targetPath, 'torrent bytes')
    await symlink(targetPath, linkPath)

    await expect(readLocalTorrentFile(linkPath)).rejects.toMatchObject({
      code: 'OPEN_FAILED'
    })
  })

  it('rejects a directory without reading it', async () => {
    const directory = await temporaryDirectory()
    const nestedDirectory = path.join(directory, 'nested')
    await mkdir(nestedDirectory)

    await expect(readLocalTorrentFile(nestedDirectory)).rejects.toMatchObject({
      code: 'NOT_REGULAR_FILE'
    })
  })

  it('rejects a device without reading it', async () => {
    await expect(readLocalTorrentFile('/dev/null')).rejects.toMatchObject({
      code: 'NOT_REGULAR_FILE'
    })
  })

  it('rejects an oversized file from descriptor metadata before reading', async () => {
    const directory = await temporaryDirectory()
    const filePath = path.join(directory, 'oversized.torrent')
    await writeFile(filePath, '')
    await truncate(filePath, LOCAL_TORRENT_MAX_BYTES + 1)

    await expect(readLocalTorrentFile(filePath)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE'
    })
  })

  it('does not issue a read when descriptor metadata is oversized', async () => {
    const close = vi.fn(async () => undefined)
    const read = vi.fn()
    const reader = createLocalTorrentReader(async () => ({
      close,
      read,
      stat: vi.fn(async () => fakeStat(LOCAL_TORRENT_MAX_BYTES + 1))
    }))

    await expect(
      reader('/already/authorized/oversized.torrent')
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('enforces the limit while a descriptor grows during the read', async () => {
    const close = vi.fn(async () => undefined)
    const read = vi.fn(
      async (buffer: Uint8Array): Promise<{ bytesRead: number }> => {
        buffer.fill(1)
        return { bytesRead: buffer.byteLength }
      }
    )
    const reader = createLocalTorrentReader(async () => ({
      close,
      read,
      stat: vi.fn(async () => fakeStat(1))
    }))

    await expect(
      reader('/already/authorized/growing.torrent')
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    expect(read).toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a descriptor whose size changes during the read', async () => {
    const close = vi.fn(async () => undefined)
    const stat = vi
      .fn()
      .mockResolvedValueOnce(fakeStat(4))
      .mockResolvedValueOnce(fakeStat(3))
    const read = vi.fn(
      async (
        buffer: Uint8Array,
        _offset: number,
        _length: number,
        position: number
      ): Promise<{ bytesRead: number }> => {
        if (position !== 0) return { bytesRead: 0 }
        buffer.set([1, 2, 3])
        return { bytesRead: 3 }
      }
    )
    const reader = createLocalTorrentReader(async () => ({
      close,
      read,
      stat
    }))

    await expect(
      reader('/already/authorized/changing.torrent')
    ).rejects.toMatchObject({ code: 'READ_FAILED' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('observes cancellation during reading and closes the descriptor', async () => {
    const controller = new AbortController()
    const close = vi.fn(async () => undefined)
    const reader = createLocalTorrentReader(async () => ({
      close,
      read: vi.fn(async (buffer: Uint8Array) => {
        controller.abort()
        return { bytesRead: Math.min(1, buffer.byteLength) }
      }),
      stat: vi.fn(async () => fakeStat(1))
    }))

    await expect(
      reader('/already/authorized/cancelled.torrent', {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not open a file when cancellation already won', async () => {
    const controller = new AbortController()
    controller.abort()
    const opener = vi.fn()
    const reader = createLocalTorrentReader(opener)

    await expect(
      reader('/already/authorized/cancelled.torrent', {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(opener).not.toHaveBeenCalled()
  })

  it('closes descriptors on stat and read failures', async () => {
    const statClose = vi.fn(async () => undefined)
    const statReader = createLocalTorrentReader(async () => ({
      close: statClose,
      read: vi.fn(),
      stat: vi.fn(async () => {
        throw new Error('/secret/stat/path')
      })
    }))

    await expect(
      statReader('/already/authorized/stat-failure.torrent')
    ).rejects.toMatchObject({ code: 'READ_FAILED' })
    expect(statClose).toHaveBeenCalledOnce()

    const readClose = vi.fn(async () => undefined)
    const readReader = createLocalTorrentReader(async () => ({
      close: readClose,
      read: vi.fn(async () => {
        throw new Error('/secret/read/path')
      }),
      stat: vi.fn(async () => fakeStat(1))
    }))

    await expect(
      readReader('/already/authorized/read-failure.torrent')
    ).rejects.toMatchObject({ code: 'READ_FAILED' })
    expect(readClose).toHaveBeenCalledOnce()
  })

  it('returns a fixed typed close error without leaking the input path', async () => {
    const secretPath = '/private/secret/noah/example.torrent'
    const reader = createLocalTorrentReader(async () => ({
      close: vi.fn(async () => {
        throw new Error(`could not close ${secretPath}`)
      }),
      read: vi.fn(async () => ({ bytesRead: 0 })),
      stat: vi.fn(async () => fakeStat(0))
    }))

    const failure = await reader(secretPath).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LocalTorrentReadError)
    expect(failure).toMatchObject({ code: 'CLOSE_FAILED' })
    expect(String(failure)).not.toContain(secretPath)
  })
})
