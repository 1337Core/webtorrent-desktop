import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import path from 'node:path'
import bencode from 'bencode'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TorrentOptions } from 'webtorrent'
import type { EngineTorrent, EngineTorrentFile } from './disk-torrent'
import { EgressPolicy } from './network-policy'
import {
  validateTorrentMetadata,
  type ValidatedTorrentMetadata
} from './torrent-metadata'
import { TorrentManager, TorrentManagerError } from './torrent-manager'

const DESTINATION_ROOT = path.join(path.sep, 'tmp', 'wu-downloads')

function fakeFile(
  length: number,
  filePath: string,
  downloaded = 0
): EngineTorrentFile {
  return {
    createReadStream: () => Readable.from([Buffer.alloc(length)]),
    downloaded,
    length,
    path: filePath,
    select: () => undefined
  }
}

class FakeTorrent extends EventEmitter implements EngineTorrent {
  destroyed = false
  done = false
  downloadSpeed = 0
  downloaded = 0
  numPeers = 0
  progress = 0
  ready = true
  timeRemaining = Number.POSITIVE_INFINITY
  uploadSpeed = 0
  uploaded = 0
  readonly peers: string[] = []
  readonly #metadata: ValidatedTorrentMetadata

  constructor(metadata: ValidatedTorrentMetadata) {
    super()
    this.#metadata = metadata
  }

  get files(): ReadonlyArray<EngineTorrentFile> {
    return this.#metadata.files.map(file =>
      fakeFile(file.length, file.path, Math.min(this.downloaded, file.length))
    )
  }

  get infoHash(): string {
    return this.#metadata.infoHash
  }

  get length(): number {
    return this.#metadata.length
  }

  get name(): string {
    return this.#metadata.name
  }

  get pieceLength(): number {
    return this.#metadata.pieceLength
  }

  get private(): boolean {
    return this.#metadata.private
  }

  get torrentFile(): Uint8Array {
    return this.#metadata.torrentBytes
  }

  addPeer(peer: string): boolean {
    this.peers.push(peer)
    return true
  }

  deselect(): void {}
  select(): void {}
  pause(): void {}
  resume(): void {}

  destroy(
    _options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void {
    this.destroyed = true
    callback()
  }
}

let single: ValidatedTorrentMetadata
let multi: ValidatedTorrentMetadata
let torrents: FakeTorrent[]
let manager: TorrentManager
let pendingMetadata: ValidatedTorrentMetadata
let addOptions: TorrentOptions[] = []

function torrentBytes(name: string, fileCount: number): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    info: {
      files: Array.from({ length: fileCount }, (_value, index) => ({
        length: 20,
        path: [`file-${index}.bin`]
      })),
      name,
      'piece length': 16,
      pieces: new Uint8Array(20 * Math.ceil((20 * fileCount) / 16))
    }
  })
}

async function addTorrent(
  metadata: ValidatedTorrentMetadata,
  selectedIndexes: ReadonlyArray<number> = [0]
): Promise<void> {
  pendingMetadata = metadata
  const before = torrents.length
  const pending = manager.add({
    destinationRoot: DESTINATION_ROOT,
    metadata,
    selectedIndexes
  })
  // The manager consults resume state before adding, so the torrent appears a
  // few microtasks later.
  for (let turn = 0; turn < 20 && torrents.length === before; turn += 1) {
    await Promise.resolve()
  }
  const torrent = torrents.at(-1)
  torrent?.emit('metadata')
  torrent?.emit('ready')
  await pending
}

beforeAll(async () => {
  const policy = new EgressPolicy()
  single = await validateTorrentMetadata(torrentBytes('alpha', 1), policy)
  multi = await validateTorrentMetadata(torrentBytes('beta', 3), policy)
})

beforeEach(() => {
  torrents = []
  addOptions = []
  pendingMetadata = single
  manager = new TorrentManager({
    resolveClient: () => ({
      add: (_torrentId: Uint8Array, options: TorrentOptions) => {
        addOptions.push(options)
        const torrent = new FakeTorrent(pendingMetadata)
        torrents.push(torrent)
        return torrent
      }
    })
  })
})

describe('TorrentManager', () => {
  it('reports an added torrent as a bounded contract summary', async () => {
    await addTorrent(single)

    expect(manager.summary(single.infoHash)).toEqual({
      downloadSpeed: 0,
      downloaded: 0,
      fileCount: 1,
      infoHash: single.infoHash,
      length: 20,
      name: 'alpha',
      peerCount: 0,
      private: false,
      progress: 0,
      selectedFileCount: 1,
      state: 'paused',
      timeRemainingMs: null,
      uploadSpeed: 0,
      uploaded: 0
    })
  })

  it('clamps hostile live counters into the contract range', async () => {
    await addTorrent(single)
    const torrent = torrents[0]
    if (!torrent) throw new Error('Expected a torrent')
    torrent.downloaded = 4_000
    torrent.numPeers = 1_000_000
    torrent.downloadSpeed = Number.NaN
    torrent.uploaded = -5
    torrent.timeRemaining = Number.POSITIVE_INFINITY

    expect(manager.summary(single.infoHash)).toMatchObject({
      downloadSpeed: 0,
      downloaded: 20,
      peerCount: 10_000,
      progress: 1,
      timeRemainingMs: null,
      uploaded: 0
    })
  })

  it('pages torrents by info hash with a stable cursor', async () => {
    await addTorrent(single)
    await addTorrent(multi)

    const ordered = [single.infoHash, multi.infoHash].sort((left, right) =>
      left.localeCompare(right)
    )
    const first = manager.list(0, 1)
    expect(first.items.map(item => item.infoHash)).toEqual([ordered[0]])
    expect(first.nextCursor).toBe(1)
    expect(first.total).toBe(2)

    const second = manager.list(first.nextCursor ?? 0, 64)
    expect(second.items.map(item => item.infoHash)).toEqual([ordered[1]])
    expect(second.nextCursor).toBeNull()
  })

  it('pages files with their selection and progress', async () => {
    await addTorrent(single)
    await addTorrent(multi, [1, 2])
    const torrent = torrents[1]
    if (!torrent) throw new Error('Expected the second torrent')
    torrent.downloaded = 10

    const page = manager.files(multi.infoHash, 0, 2)
    expect(page.infoHash).toBe(multi.infoHash)
    expect(page.total).toBe(3)
    expect(page.nextCursor).toBe(2)
    expect(page.items).toEqual([
      {
        downloaded: 10,
        index: 0,
        length: 20,
        path: 'beta/file-0.bin',
        progress: 0.5,
        selected: false
      },
      {
        downloaded: 10,
        index: 1,
        length: 20,
        path: 'beta/file-1.bin',
        progress: 0.5,
        selected: true
      }
    ])
  })

  it('moves a torrent through pause, resume, and remove', async () => {
    await addTorrent(single)

    expect((await manager.resume(single.infoHash)).state).toBe('downloading')
    expect((await manager.pause(single.infoHash)).state).toBe('paused')

    await manager.remove(single.infoHash)
    expect(manager.size).toBe(0)
    expect(manager.registry.has(single.infoHash)).toBe(false)
    expect(() => manager.summary(single.infoHash)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }) as Error
    )
  })

  it('reports a seeding torrent once it is complete', async () => {
    await addTorrent(single)
    const torrent = torrents[0]
    if (!torrent) throw new Error('Expected a torrent')
    torrent.done = true

    expect((await manager.resume(single.infoHash)).state).toBe('seeding')
  })

  it('rejects unknown torrents, indexes, and page requests', async () => {
    await addTorrent(multi, [0])

    expect(() => manager.files('0'.repeat(40), 0, 10)).toThrow(
      TorrentManagerError
    )
    expect(() => manager.updateSelection(multi.infoHash, [9])).toThrow(
      expect.objectContaining({ code: 'INPUT_INVALID' }) as Error
    )
    expect(() => manager.list(-1, 10)).toThrow(
      expect.objectContaining({ code: 'INPUT_INVALID' }) as Error
    )
    expect(() => manager.list(0, 0)).toThrow(
      expect.objectContaining({ code: 'INPUT_INVALID' }) as Error
    )
    expect(() => manager.list(0, 65)).toThrow(
      expect.objectContaining({ code: 'INPUT_INVALID' }) as Error
    )
    expect(manager.files(multi.infoHash, 99, 10)).toMatchObject({
      items: [],
      nextCursor: null,
      total: 3
    })
  })

  it('updates the selected file count through the manager', async () => {
    await addTorrent(multi, [0])

    expect(manager.updateSelection(multi.infoHash, [0, 2])).toMatchObject({
      selectedFileCount: 2
    })
    expect(
      manager.files(multi.infoHash, 0, 64).items.map(item => item.selected)
    ).toEqual([true, false, true])
  })

  it('passes a validated resume bitfield and drops it when stale', async () => {
    const bitfield = Uint8Array.from([0b1000_0000])
    const removed: string[] = []
    let usable = true
    manager = new TorrentManager({
      resolveClient: () => ({
        add: (_torrentId: Uint8Array, options: TorrentOptions) => {
          addOptions.push(options)
          const torrent = new FakeTorrent(pendingMetadata)
          torrents.push(torrent)
          return torrent
        }
      }),
      resume: {
        describe: () => {
          throw new Error('unused')
        },
        evaluate: () =>
          Promise.resolve(
            usable
              ? { bitfield, usable: true as const }
              : { reason: 'FILE_CHANGED' as const, usable: false as const }
          ),
        load: () => Promise.resolve(null),
        remove: infoHash => {
          removed.push(infoHash)
          return Promise.resolve()
        },
        save: () => Promise.resolve()
      }
    })

    await addTorrent(single)
    expect(addOptions[0]?.bitfield).toEqual(bitfield)
    expect(addOptions[0]?.skipVerify).toBe(false)

    await manager.remove(single.infoHash)
    expect(removed).toEqual([single.infoHash])

    usable = false
    await addTorrent(single)
    expect(addOptions[1]?.bitfield).toBeUndefined()
  })

  it('records the selection and pieces a restore reads back', async () => {
    const saved: Array<{ cleanShutdown: boolean; selectedPaths: string[] }> = []
    manager = new TorrentManager({
      resolveClient: () => ({
        add: (_torrentId: Uint8Array, options: TorrentOptions) => {
          addOptions.push(options)
          const torrent = new FakeTorrent(pendingMetadata)
          torrents.push(torrent)
          return torrent
        }
      }),
      resume: {
        describe: input =>
          Promise.resolve({
            cleanShutdown: input.cleanShutdown,
            selectedPaths: [...input.expectation.selectedPaths]
          } as never),
        evaluate: () =>
          Promise.resolve({
            reason: 'SCHEMA_MISMATCH' as const,
            usable: false as const
          }),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
        save: (sidecar: unknown) => {
          saved.push(
            sidecar as { cleanShutdown: boolean; selectedPaths: string[] }
          )
          return Promise.resolve()
        }
      }
    })

    await addTorrent(multi)
    const wanted = multi.files[0]
    if (!wanted) throw new Error('The fixture has no files')
    manager.updateSelection(multi.infoHash, [wanted.index])

    // Nothing wrote a sidecar before this change, so a restart selected every
    // file again and downloaded what the owner had deselected.
    // updateSelection persists without blocking its caller.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(saved.length).toBeGreaterThan(0)
    expect(saved.at(-1)?.selectedPaths).toEqual([wanted.path])

    await manager.closeAll()
    expect(saved.at(-1)?.cleanShutdown).toBe(true)
  })

  it('closes every session on shutdown', async () => {
    await addTorrent(single)
    await addTorrent(multi)

    await manager.closeAll()
    expect(manager.size).toBe(0)
    expect(torrents.every(torrent => torrent.destroyed)).toBe(true)
  })
})
