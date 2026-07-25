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

  /** Delivers the info dictionary the way WebTorrent does. */
  deliver(bytes: Uint8Array): void {
    this.torrentFile = bytes
    this.emit('metadata')
  }
}

type Harness = {
  acquisition: MetadataAcquisition
  discovery: { started: number; stopped: number }
  torrents: FakeTorrent[]
}

function harness(options: { discoverFails?: boolean } = {}): Harness {
  const torrents: FakeTorrent[] = []
  const discovery = { started: 0, stopped: 0 }

  const acquisition = new MetadataAcquisition({
    createClient: (): AcquisitionClient => ({
      add: () => {
        const torrent = new FakeTorrent()
        torrents.push(torrent)
        return torrent
      }
    }),
    discover: async () => {
      if (options.discoverFails) throw new Error('unreachable')
      discovery.started += 1
      return async () => {
        discovery.stopped += 1
      }
    },
    stagingPath: '/tmp/staging',
    timeoutMs: 50
  })

  return { acquisition, discovery, torrents }
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

    expect(new Uint8Array(await pending)).toEqual(fixture.bytes)
    // The staging torrent never survives its own acquisition.
    expect(context.torrents[0]?.destroyed).toBe(true)
    expect(context.torrents[0]?.destroyedStore).toBe(true)
    expect(context.discovery).toEqual({ started: 1, stopped: 1 })
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

  it('accepts nothing after it closes', async () => {
    const context = harness()
    context.acquisition.close()

    await expect(
      context.acquisition.acquire(preparedFor('a'.repeat(40)))
    ).rejects.toMatchObject({ code: 'CLOSED' })
    expect(context.torrents).toHaveLength(0)
  })
})
