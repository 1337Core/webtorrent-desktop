import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FSWatcher } from 'chokidar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostics } from './diagnostics'
import {
  FolderWatcher,
  FolderWatcherError,
  FOLDER_WATCH_LIMITS
} from './folder-watcher'

class FakeWatcher extends EventEmitter {
  closed = false

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

let root = ''
let watchers: FakeWatcher[] = []
let reported: string[] = []
let watcher: FolderWatcher

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

/** The report path stats the file, so a real tick is required. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-watch-'))
  watchers = []
  reported = []
  watcher = new FolderWatcher({
    createWatcher: () => {
      const created = new FakeWatcher()
      watchers.push(created)
      return created as unknown as FSWatcher
    },
    diagnostics: diagnostics(),
    onTorrent: torrentPath => reported.push(torrentPath)
  })
})

afterEach(async () => {
  await watcher.stop()
  await rm(root, { force: true, recursive: true })
})

describe('FolderWatcher', () => {
  it('reports a real torrent file directly inside the folder', async () => {
    const torrentPath = path.join(root, 'example.torrent')
    await writeFile(torrentPath, 'd4:infod4:name4:teste')

    await watcher.watch(root)
    watchers[0]?.emit('add', torrentPath)
    await settle()

    expect(reported).toEqual([torrentPath])
    expect(watcher.folder).toBe(root)
  })

  it('ignores other extensions, nested paths, and symlinks', async () => {
    const nested = path.join(root, 'nested')
    await mkdir(nested)
    const nestedTorrent = path.join(nested, 'deep.torrent')
    await writeFile(nestedTorrent, 'data')
    const other = path.join(root, 'notes.txt')
    await writeFile(other, 'text')
    const linked = path.join(root, 'linked.torrent')
    await symlink(nestedTorrent, linked)

    await watcher.watch(root)
    for (const candidate of [nestedTorrent, other, linked]) {
      watchers[0]?.emit('add', candidate)
    }
    await settle()

    expect(reported).toEqual([])
  })

  it('ignores an oversized or absent torrent', async () => {
    const oversized = path.join(root, 'huge.torrent')
    await writeFile(
      oversized,
      Buffer.alloc(FOLDER_WATCH_LIMITS.maxTorrentBytes + 1)
    )

    await watcher.watch(root)
    watchers[0]?.emit('add', oversized)
    watchers[0]?.emit('add', path.join(root, 'absent.torrent'))
    await settle()

    expect(reported).toEqual([])
  })

  it('refuses a relative or denormalized folder', async () => {
    await expect(watcher.watch('relative/folder')).rejects.toBeInstanceOf(
      FolderWatcherError
    )
    await expect(watcher.watch(`${root}/./`)).rejects.toBeInstanceOf(
      FolderWatcherError
    )
    expect(watchers).toHaveLength(0)
  })

  it('replaces an existing watch and stops cleanly', async () => {
    const second = await mkdtemp(path.join(tmpdir(), 'wu-watch-second-'))
    try {
      await watcher.watch(root)
      await watcher.watch(second)

      expect(watchers).toHaveLength(2)
      expect(watchers[0]?.closed).toBe(true)
      expect(watcher.folder).toBe(second)

      await watcher.stop()
      expect(watchers[1]?.closed).toBe(true)
      expect(watcher.folder).toBeNull()
      await watcher.stop()
    } finally {
      await rm(second, { force: true, recursive: true })
    }
  })

  it('drops events once the watch has stopped', async () => {
    const torrentPath = path.join(root, 'example.torrent')
    await writeFile(torrentPath, 'data')
    await watcher.watch(root)
    const created = watchers[0]

    await watcher.stop()
    created?.emit('add', torrentPath)
    await settle()

    expect(reported).toEqual([])
  })
})
