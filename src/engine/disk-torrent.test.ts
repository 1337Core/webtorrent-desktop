import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import path from 'node:path'
import bencode from 'bencode'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TorrentOptions } from 'webtorrent'
import {
  DiskTorrentError,
  DiskTorrentSession,
  DISK_TORRENT_TIMEOUTS,
  type DiskTorrentAddInput,
  type DiskTorrentSessionOptions,
  type EngineAddClient,
  type EngineTorrent,
  type EngineTorrentFile
} from './disk-torrent'
import { EgressPolicy } from './network-policy'
import {
  validateTorrentMetadata,
  type ValidatedTorrentMetadata
} from './torrent-metadata'
import { TorrentRegistry } from './torrent-registry'

const DOWNLOAD_ROOT = path.join(path.sep, 'tmp', 'wu-downloads')

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
  paused = true
  progress = 0
  ready = false
  timeRemaining = Number.POSITIVE_INFINITY
  uploadSpeed = 0
  uploaded = 0
  readonly destroyCalls: Array<{ destroyStore: boolean }> = []
  readonly peers: string[] = []
  readonly connections: unknown[] = []
  readonly selectionCalls: string[] = []
  #metadata: ValidatedTorrentMetadata
  #overrides: Partial<EngineTorrent>

  constructor(
    metadata: ValidatedTorrentMetadata,
    overrides: Partial<EngineTorrent> = {}
  ) {
    super()
    this.#metadata = metadata
    this.#overrides = overrides
  }

  get files(): ReadonlyArray<EngineTorrentFile> {
    return (
      this.#overrides.files ??
      this.#metadata.files.map(file => fakeFile(file.length, file.path, 0))
    )
  }

  get infoHash(): string {
    return this.#overrides.infoHash ?? this.#metadata.infoHash
  }

  get length(): number {
    return this.#overrides.length ?? this.#metadata.length
  }

  get name(): string {
    return this.#overrides.name ?? this.#metadata.name
  }

  get pieceLength(): number {
    return this.#overrides.pieceLength ?? this.#metadata.pieceLength
  }

  get private(): boolean {
    return this.#overrides.private ?? this.#metadata.private
  }

  get torrentFile(): Uint8Array {
    return this.#overrides.torrentFile ?? this.#metadata.torrentBytes
  }

  addPeer(peer: unknown, _source?: string): boolean {
    if (typeof peer === 'string') this.peers.push(peer)
    else this.connections.push(peer)
    return true
  }

  deselect(start: number, end: number): void {
    this.selectionCalls.push(`deselect:${start}-${end}`)
  }

  select(start: number, end: number, priority?: number): void {
    this.selectionCalls.push(`select:${start}-${end}:${priority ?? 0}`)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  destroy(
    options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void {
    this.destroyCalls.push(options)
    this.destroyed = true
    callback()
  }

  reachReady(): void {
    this.emit('metadata')
    this.emit('ready')
  }
}

type Harness = {
  addOptions: TorrentOptions[]
  registry: TorrentRegistry
  started: number
  stopped: number
  torrents: FakeTorrent[]
}

let metadata: ValidatedTorrentMetadata
let harness: Harness

function torrentBytes(): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    info: {
      files: [
        { length: 20, path: ['first.bin'] },
        { length: 20, path: ['second.bin'] }
      ],
      name: 'payload',
      'piece length': 16,
      pieces: new Uint8Array(60)
    }
  })
}

function addInput(
  overrides: Partial<DiskTorrentAddInput> & {
    torrentOverrides?: Partial<EngineTorrent>
  } = {}
): DiskTorrentAddInput {
  const client: EngineAddClient = {
    add: (_torrentId: Uint8Array, options: TorrentOptions) => {
      harness.addOptions.push(options)
      const torrent = new FakeTorrent(
        metadata,
        overrides.torrentOverrides ?? {}
      )
      harness.torrents.push(torrent)
      return torrent
    }
  }
  return {
    client,
    downloadRoot: DOWNLOAD_ROOT,
    metadata,
    owner: 'public',
    selectedIndexes: [0],
    ...overrides
  }
}

function sessionOptions(
  overrides: Partial<DiskTorrentSessionOptions> = {}
): DiskTorrentSessionOptions {
  return {
    createActivation: () => ({
      start: () => {
        harness.started += 1
      },
      stop: () => {
        harness.stopped += 1
        return Promise.resolve()
      }
    }),
    registry: harness.registry,
    ...overrides
  }
}

async function addReadySession(
  input: Partial<DiskTorrentAddInput> = {},
  options: Partial<DiskTorrentSessionOptions> = {}
): Promise<DiskTorrentSession> {
  const pending = DiskTorrentSession.add(
    addInput(input),
    sessionOptions(options)
  )
  harness.torrents.at(-1)?.reachReady()
  return await pending
}

beforeAll(async () => {
  metadata = await validateTorrentMetadata(torrentBytes(), new EgressPolicy())
})

beforeEach(() => {
  harness = {
    addOptions: [],
    registry: new TorrentRegistry(),
    started: 0,
    stopped: 0,
    torrents: []
  }
})

describe('DiskTorrentSession', () => {
  it('adds paused and deselected with the qualified options', async () => {
    const session = await addReadySession()

    expect(harness.addOptions[0]).toMatchObject({
      addUID: false,
      deselect: true,
      destroyStoreOnDestroy: false,
      path: DOWNLOAD_ROOT,
      paused: true,
      private: false,
      skipVerify: false,
      storeCacheSlots: 0
    })
    expect(harness.addOptions[0]?.store).toBeTypeOf('function')
    expect(harness.addOptions[0]?.storeOpts).toMatchObject({
      guardedStoreToken: expect.any(Symbol) as symbol
    })
    expect(session.state).toBe('paused')
    expect(harness.registry.admits(metadata.infoHash)).toBe(true)
    expect(harness.started).toBe(0)
    expect(harness.torrents[0]?.selectionCalls).toEqual([])
  })

  it('destroys and rolls back when the barrier rejects the metadata', async () => {
    const pending = DiskTorrentSession.add(
      addInput({ torrentOverrides: { name: 'renamed' } }),
      sessionOptions()
    )
    const torrent = harness.torrents.at(-1)
    torrent?.emit('metadata')

    await expect(pending).rejects.toBeInstanceOf(DiskTorrentError)
    await pending.catch((error: unknown) => {
      expect(error).toMatchObject({
        code: 'COMMIT_REJECTED',
        detail: 'NAME_MISMATCH'
      })
    })
    expect(torrent?.destroyCalls).toEqual([{ destroyStore: false }])
    expect(harness.registry.has(metadata.infoHash)).toBe(false)
    expect(harness.started).toBe(0)
  })

  it('refuses a ready torrent that never passed the barrier', async () => {
    const pending = DiskTorrentSession.add(addInput(), sessionOptions())
    harness.torrents.at(-1)?.emit('ready')

    await expect(pending).rejects.toMatchObject({
      code: 'COMMIT_REJECTED',
      detail: 'missing barrier'
    })
    expect(harness.registry.has(metadata.infoHash)).toBe(false)
  })

  it('rolls the reservation back when the add itself fails', async () => {
    await expect(
      DiskTorrentSession.add(
        addInput({
          client: {
            add: () => {
              throw new Error('add exploded')
            }
          }
        }),
        sessionOptions()
      )
    ).rejects.toMatchObject({ code: 'ADD_FAILED' })
    expect(harness.registry.has(metadata.infoHash)).toBe(false)
  })

  it('rebuilds the whole selection on resume and clears it on pause', async () => {
    const session = await addReadySession({ selectedIndexes: [1] })
    const torrent = harness.torrents[0]
    if (!torrent) throw new Error('Expected a torrent')

    session.resume()
    expect(session.state).toBe('running')
    expect(torrent.paused).toBe(false)
    expect(harness.started).toBe(1)
    // 20-byte files with 16-byte pieces: the second file owns pieces 1..2.
    expect(torrent.selectionCalls).toEqual(['deselect:0-2', 'select:1-2:1'])

    session.updateSelection([0, 1])
    expect(torrent.selectionCalls.at(-1)).toBe('select:0-2:1')

    await session.pause()
    expect(session.state).toBe('paused')
    expect(harness.stopped).toBe(1)
    expect(torrent.selectionCalls.at(-1)).toBe('deselect:0-2')
    expect(torrent.paused).toBe(true)
  })

  it('starts a fresh activation for every resume', async () => {
    const session = await addReadySession()

    session.resume()
    await session.pause()
    session.resume()

    expect(harness.started).toBe(2)
    expect(harness.stopped).toBe(1)
  })

  it('destroys once and releases the tombstone on the destroy callback', async () => {
    const session = await addReadySession()
    session.resume()

    await session.remove()
    await session.remove()

    const torrent = harness.torrents[0]
    expect(torrent?.destroyCalls).toEqual([{ destroyStore: false }])
    expect(harness.stopped).toBe(1)
    expect(session.state).toBe('removed')
    expect(harness.registry.has(metadata.infoHash)).toBe(false)
    expect(() =>
      harness.registry.reserve({
        fileCount: metadata.files.length,
        infoHash: metadata.infoHash,
        owner: 'public'
      })
    ).not.toThrow()
  })

  it('keeps the tombstone while a destroy callback never arrives', async () => {
    vi.useFakeTimers()
    try {
      const session = await addReadySession(
        {},
        { destroyTimeoutMs: DISK_TORRENT_TIMEOUTS.destroyMs }
      )
      const torrent = harness.torrents[0]
      if (!torrent) throw new Error('Expected a torrent')
      torrent.destroy = (options): void => {
        torrent.destroyCalls.push(options)
      }

      const removal = session.remove()
      await vi.advanceTimersByTimeAsync(DISK_TORRENT_TIMEOUTS.destroyMs)
      await removal

      expect(torrent.destroyCalls).toEqual([{ destroyStore: false }])
      expect(harness.registry.has(metadata.infoHash)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a torrent error during the add as a contained failure', async () => {
    const pending = DiskTorrentSession.add(addInput(), sessionOptions())
    harness.torrents.at(-1)?.emit('error', new Error('bad peer'))

    await expect(pending).rejects.toMatchObject({ code: 'TORRENT_ERROR' })
    expect(harness.registry.has(metadata.infoHash)).toBe(false)
  })

  it('admits a discovered peer only for a running committed generation', async () => {
    const session = await addReadySession(
      {},
      { peerFilter: address => address !== '10.0.0.5:6881' }
    )
    const torrent = harness.torrents[0]
    if (!torrent) throw new Error('Expected a torrent')

    expect(session.admitPeer('203.0.113.7:6881')).toBe(false)

    session.resume()
    expect(session.admitPeer('203.0.113.7:6881')).toBe(true)
    expect(session.admitPeer('10.0.0.5:6881')).toBe(false)
    expect(torrent.peers).toEqual(['203.0.113.7:6881'])

    await session.pause()
    expect(session.admitPeer('203.0.113.8:6881')).toBe(false)
    expect(torrent.peers).toEqual(['203.0.113.7:6881'])
  })

  it('admits a signaled connection through the same peer gate', async () => {
    const session = await addReadySession(
      {},
      { peerFilter: address => address !== '10.0.0.5' }
    )
    const torrent = harness.torrents[0]
    if (!torrent) throw new Error('Expected a torrent')
    const connected = { destroy: () => undefined, remoteAddress: '203.0.113.9' }

    expect(session.admitConnection(connected)).toBe(false)

    session.resume()
    expect(session.admitConnection(connected)).toBe(true)
    expect(
      session.admitConnection({
        destroy: () => undefined,
        remoteAddress: '10.0.0.5'
      })
    ).toBe(false)
    // A transport with no remote address is never handed to WebTorrent.
    expect(session.admitConnection({ destroy: () => undefined })).toBe(false)
    expect(torrent.connections).toEqual([connected])
  })

  it('filters peers WebTorrent discovers for itself', async () => {
    const session = await addReadySession(
      {},
      { peerFilter: address => address !== '10.0.0.5:6881' }
    )
    const torrent = harness.torrents[0]
    if (!torrent) throw new Error('Expected a torrent')
    session.resume()

    // WebTorrent's own PEX path calls addPeer directly; it must still pass
    // this session's address policy.
    expect(torrent.addPeer('10.0.0.5:6881', 'ut_pex')).toBe(false)
    expect(torrent.addPeer('203.0.113.20:6881', 'ut_pex')).toBe(true)
    expect(torrent.peers).toEqual(['203.0.113.20:6881'])

    await session.pause()
    // A paused generation discovers nothing, whatever WebTorrent believes.
    expect(torrent.addPeer('203.0.113.21:6881', 'ut_pex')).toBe(false)
    expect(torrent.peers).toEqual(['203.0.113.20:6881'])
  })

  it('refuses lifecycle commands that do not match the current state', async () => {
    const session = await addReadySession()

    expect(() => session.resume()).not.toThrow()
    expect(() => session.resume()).not.toThrow()
    await session.pause()
    await expect(session.pause()).resolves.toBeUndefined()

    await session.remove()
    expect(() => session.resume()).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
    await expect(session.pause()).rejects.toMatchObject({
      code: 'STATE_CONFLICT'
    })
    expect(() => session.updateSelection([0])).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
  })
})
