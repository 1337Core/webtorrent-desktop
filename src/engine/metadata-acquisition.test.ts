import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  METADATA_ACQUISITION_LIMITS,
  MetadataAcquisition,
  type AcquisitionClient,
  type AcquisitionTorrent
} from './metadata-acquisition'
import type { PreparedMagnet } from './torrent-metadata'

function bencode(value: unknown): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`)
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value])
  }
  if (typeof value === 'string') return bencode(Buffer.from(value, 'utf8'))
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)
  )
  return Buffer.concat([
    Buffer.from('d'),
    ...entries.flatMap(([key, entry]) => [bencode(key), bencode(entry)]),
    Buffer.from('e')
  ])
}

function torrentFixture(name = 'staged'): {
  bytes: Uint8Array
  infoHash: string
} {
  const info = {
    length: 16,
    name,
    'piece length': 16_384,
    pieces: Buffer.alloc(20)
  }
  return {
    bytes: new Uint8Array(bencode({ info })),
    infoHash: createHash('sha1').update(bencode(info)).digest('hex')
  }
}

class FakeTorrent extends EventEmitter implements AcquisitionTorrent {
  destroyed = false
  destroyedStore = false
  readonly peers: string[] = []
  torrentFile: Uint8Array | undefined

  addPeer(peer: string): boolean {
    this.peers.push(peer)
    return true
  }

  destroy(
    options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void {
    this.destroyed = true
    this.destroyedStore = options.destroyStore
    callback()
  }

  removePeer(peer: string): void {
    const index = this.peers.indexOf(peer)
    if (index >= 0) this.peers.splice(index, 1)
  }

  /** Delivers the info dictionary the way WebTorrent does. */
  deliver(bytes: Uint8Array): void {
    this.torrentFile = bytes
    this.emit('metadata')
  }
}

type Harness = {
  acquisition: MetadataAcquisition
  addOptions: Record<string, unknown>[]
  discovery: { frozen: number; started: number; stopped: number }
  staging: { leased: number; released: number }
  torrents: FakeTorrent[]
}

function harness(
  options: {
    addFails?: boolean
    discoverFails?: boolean
    stagingFails?: boolean
  } = {}
): Harness {
  const torrents: FakeTorrent[] = []
  const addOptions: Record<string, unknown>[] = []
  const discovery = { frozen: 0, started: 0, stopped: 0 }
  const staging = { leased: 0, released: 0 }

  const client: AcquisitionClient = {
    add: (_uri, addOption) => {
      addOptions.push(addOption)
      if (options.addFails) throw new Error('duplicate torrent')
      const torrent = new FakeTorrent()
      torrents.push(torrent)
      return torrent
    }
  }

  const acquisition = new MetadataAcquisition({
    discover: () => {
      discovery.started += 1
      let frozen = false
      return {
        freeze: () => {
          if (frozen) return
          frozen = true
          discovery.frozen += 1
        },
        ready: options.discoverFails
          ? Promise.reject(new Error('unreachable'))
          : Promise.resolve(),
        stop: async () => {
          discovery.stopped += 1
        }
      }
    },
    openStaging: async () => {
      if (options.stagingFails) throw new Error('no staging client')
      staging.leased += 1
      return {
        client,
        peerId: new Uint8Array(20).fill(7),
        port: 51_413,
        release: async () => {
          staging.released += 1
        }
      }
    },
    timeoutMs: 50
  })

  return { acquisition, addOptions, discovery, staging, torrents }
}

function preparedFor(infoHash: string): PreparedMagnet {
  return {
    dhtEnabled: false,
    infoHash,
    magnet: {} as PreparedMagnet['magnet'],
    magnetUri: `magnet:?xt=urn:btih:${infoHash}`,
    selection: [],
    trackers: ['https://tracker.example/announce'],
    warnings: [],
    webSeeds: [],
    xsRemoved: false
  }
}

describe('MetadataAcquisition', () => {
  it('returns metadata bound to the requested info hash', async () => {
    const context = harness()
    const fixture = torrentFixture()

    const pending = context.acquisition.acquire(preparedFor(fixture.infoHash))
    await vi.waitFor(() => expect(context.torrents).toHaveLength(1))
    context.torrents[0]?.deliver(fixture.bytes)

    // Destruction begins inside the metadata event, before WebTorrent can
    // continue into verification or payload I/O.
    expect(context.torrents[0]?.destroyed).toBe(true)
    expect(context.torrents[0]?.destroyedStore).toBe(true)
    expect(context.addOptions[0]).toMatchObject({
      announce: [],
      deselect: true,
      destroyStoreOnDestroy: true,
      store: expect.any(Function),
      storeCacheSlots: 0
    })
    expect(new Uint8Array(await pending)).toEqual(fixture.bytes)
    expect(context.discovery).toEqual({ frozen: 1, started: 1, stopped: 1 })
    // The staging client is leased for the acquisition and given back with it.
    expect(context.staging).toEqual({ leased: 1, released: 1 })
  })

  it('refuses metadata whose canonical info hash is not the one requested', async () => {
    const context = harness()
    const other = torrentFixture('different')

    const pending = context.acquisition.acquire(preparedFor('a'.repeat(40)))
    await vi.waitFor(() => expect(context.torrents).toHaveLength(1))
    context.torrents[0]?.deliver(other.bytes)

    await expect(pending).rejects.toMatchObject({ code: 'BINDING_MISMATCH' })
    expect(context.torrents[0]?.destroyed).toBe(true)
  })

  it('gives up on its own deadline and tears the acquisition down', async () => {
    const context = harness()

    await expect(
      context.acquisition.acquire(preparedFor('b'.repeat(40)))
    ).rejects.toMatchObject({ code: 'TIMED_OUT' })

    expect(context.torrents[0]?.destroyed).toBe(true)
    expect(context.discovery.stopped).toBe(1)
    expect(context.acquisition.activeCount).toBe(0)
  })

  it('stops when the caller aborts', async () => {
    const context = harness()
    const controller = new AbortController()

    const pending = context.acquisition.acquire(
      preparedFor('c'.repeat(40)),
      controller.signal
    )
    await vi.waitFor(() => expect(context.torrents).toHaveLength(1))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    expect(context.torrents[0]?.destroyed).toBe(true)
  })

  it('reports a discovery source that never starts', async () => {
    const context = harness({ discoverFails: true })

    await expect(
      context.acquisition.acquire(preparedFor('d'.repeat(40)))
    ).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(context.torrents[0]?.destroyed).toBe(true)
  })

  it('freezes discovery synchronously before torrent destruction', async () => {
    const fixture = torrentFixture()
    const order: string[] = []
    const torrent = new FakeTorrent()
    torrent.destroy = (_options, callback) => {
      order.push('destroy')
      torrent.destroyed = true
      callback()
    }
    const acquisition = new MetadataAcquisition({
      discover: () => ({
        freeze: () => order.push('freeze'),
        ready: Promise.resolve(),
        stop: async () => undefined
      }),
      openStaging: async () => ({
        client: { add: () => torrent },
        peerId: new Uint8Array(20),
        port: 51_413,
        release: async () => undefined
      })
    })

    const pending = acquisition.acquire(preparedFor(fixture.infoHash))
    await vi.waitFor(() => expect(torrent.listenerCount('metadata')).toBe(1))
    torrent.deliver(fixture.bytes)
    await pending

    expect(order.slice(0, 2)).toEqual(['freeze', 'destroy'])
  })

  it('marks a destroy timeout unhealthy and holds the slot until callback', async () => {
    const fixture = torrentFixture()
    const torrent = new FakeTorrent()
    const destroy = {
      finish: null as ((error?: Error) => void) | null
    }
    torrent.destroy = (options, callback) => {
      torrent.destroyed = true
      torrent.destroyedStore = options.destroyStore
      destroy.finish = callback
    }
    const released = vi.fn()
    const unhealthy = vi.fn()
    const acquisition = new MetadataAcquisition({
      destroyTimeoutMs: 10,
      discover: () => ({
        freeze: () => undefined,
        ready: Promise.resolve(),
        stop: async () => undefined
      }),
      openStaging: async () => ({
        client: { add: () => torrent },
        peerId: new Uint8Array(20),
        port: 51_413,
        release: async () => {
          released()
        }
      }),
      onUnhealthy: unhealthy
    })

    const pending = acquisition.acquire(preparedFor(fixture.infoHash))
    await vi.waitFor(() => expect(torrent.listenerCount('metadata')).toBe(1))
    torrent.deliver(fixture.bytes)

    await expect(pending).rejects.toMatchObject({ code: 'TEARDOWN_FAILED' })
    expect(unhealthy).toHaveBeenCalledOnce()
    expect(released).not.toHaveBeenCalled()
    expect(acquisition.activeCount).toBe(1)
    await expect(
      acquisition.acquire(preparedFor(fixture.infoHash))
    ).rejects.toMatchObject({ code: 'TEARDOWN_FAILED' })

    if (!destroy.finish) throw new Error('Expected a destroy callback')
    destroy.finish()
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(acquisition.activeCount).toBe(0))
  })

  it('does not release a slot from the destroyed flag before a callback', async () => {
    const torrent = new FakeTorrent()
    const released = vi.fn()
    const unhealthy = vi.fn()
    const acquisition = new MetadataAcquisition({
      destroyTimeoutMs: 10,
      discover: () => ({
        freeze: () => undefined,
        ready: Promise.resolve(),
        stop: async () => undefined
      }),
      onUnhealthy: unhealthy,
      openStaging: async () => ({
        client: { add: () => torrent },
        peerId: new Uint8Array(20),
        port: 51_413,
        release: async () => {
          released()
        }
      })
    })
    const pending = acquisition.acquire(preparedFor('d'.repeat(40)))
    await vi.waitFor(() => expect(torrent.listenerCount('error')).toBe(1))

    torrent.destroyed = true
    torrent.emit('error', new Error('auto-destroyed'))

    await expect(pending).rejects.toMatchObject({ code: 'TEARDOWN_FAILED' })
    expect(unhealthy).toHaveBeenCalledOnce()
    expect(released).not.toHaveBeenCalled()
    expect(acquisition.activeCount).toBe(1)
  })

  it('runs at most two acquisitions at once', async () => {
    const context = harness()
    const first = context.acquisition.acquire(preparedFor('e'.repeat(40)))
    const second = context.acquisition.acquire(preparedFor('f'.repeat(40)))
    await vi.waitFor(() =>
      expect(context.acquisition.activeCount).toBe(
        METADATA_ACQUISITION_LIMITS.maxConcurrent
      )
    )

    await expect(
      context.acquisition.acquire(preparedFor('0'.repeat(40)))
    ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })

    await expect(first).rejects.toMatchObject({ code: 'TIMED_OUT' })
    await expect(second).rejects.toMatchObject({ code: 'TIMED_OUT' })
    expect(context.acquisition.activeCount).toBe(0)
  })

  it('reports a staging client it cannot obtain', async () => {
    const context = harness({ stagingFails: true })

    await expect(
      context.acquisition.acquire(preparedFor('a'.repeat(40)))
    ).rejects.toMatchObject({ code: 'STAGING_UNAVAILABLE' })
    expect(context.torrents).toHaveLength(0)
    expect(context.acquisition.activeCount).toBe(0)
  })

  it('releases its staging lease when the client refuses the add', async () => {
    const context = harness({ addFails: true })

    await expect(
      context.acquisition.acquire(preparedFor('a'.repeat(40)))
    ).rejects.toMatchObject({ code: 'TORRENT_ERROR' })
    expect(context.staging).toEqual({ leased: 1, released: 1 })
    expect(context.acquisition.activeCount).toBe(0)
  })

  it('accepts nothing after it closes', async () => {
    const context = harness()
    context.acquisition.close()

    await expect(
      context.acquisition.acquire(preparedFor('a'.repeat(40)))
    ).rejects.toMatchObject({ code: 'CLOSED' })
    expect(context.torrents).toHaveLength(0)
  })
})
