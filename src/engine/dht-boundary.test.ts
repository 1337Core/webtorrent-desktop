import { EventEmitter } from 'node:events'
import bencode from 'bencode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DhtBoundary,
  DhtBoundaryError,
  DHT_BOOTSTRAP_ENDPOINTS,
  DHT_BOUNDARY_LIMITS,
  type DhtPeerDelivery,
  type DhtSocket
} from './dht-boundary'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const BOOTSTRAP_ADDRESS = '93.184.216.34'
const PEER_ADDRESS = '45.33.32.9'

type SentDatagram = {
  address: string
  message: Uint8Array
  port: number
}

class FakeSocket extends EventEmitter implements DhtSocket {
  readonly sent: SentDatagram[] = []
  bound = false
  closed = false

  bind(_port: number, callback?: () => void): void {
    this.bound = true
    callback?.()
  }

  close(callback?: () => void): void {
    this.closed = true
    callback?.()
  }

  send(
    message: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void {
    this.sent.push({ address, message, port })
    callback?.(null)
  }

  deliver(
    message: Uint8Array,
    remote: { address: string; port: number }
  ): void {
    this.emit('message', message, remote)
  }
}

function decodeQuery(datagram: Uint8Array): {
  method: string
  transaction: Uint8Array
} {
  const decoded = bencode.decode(Buffer.from(datagram)) as Record<
    string,
    unknown
  >
  return {
    method: Buffer.from(decoded.q as Uint8Array).toString('latin1'),
    transaction: new Uint8Array(decoded.t as Uint8Array)
  }
}

function compactPeer(address: string, port: number): Uint8Array {
  const bytes = new Uint8Array(6)
  address.split('.').forEach((octet, index) => {
    bytes[index] = Number(octet)
  })
  bytes[4] = (port >> 8) & 0xff
  bytes[5] = port & 0xff
  return bytes
}

function peersResponse(
  transaction: Uint8Array,
  options: { token?: Uint8Array; values?: Uint8Array[] } = {}
): Uint8Array {
  return new Uint8Array(
    bencode.encode({
      r: {
        id: new Uint8Array(20).fill(3),
        token: options.token ?? new Uint8Array([9, 9, 9, 9]),
        values: options.values ?? [compactPeer(PEER_ADDRESS, 6881)]
      },
      t: transaction,
      y: 'r'
    })
  )
}

type Harness = {
  boundary: DhtBoundary
  deliveries: DhtPeerDelivery[]
  sockets: FakeSocket[]
  warnings: string[]
}

function createHarness(
  options: { resolve?: () => Promise<ReadonlyArray<string>> } = {}
): Harness {
  const sockets: FakeSocket[] = []
  const deliveries: DhtPeerDelivery[] = []
  const warnings: string[] = []
  const boundary = new DhtBoundary({
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onPeers: delivery => deliveries.push(delivery),
    onWarning: code => warnings.push(code),
    resolveBootstrap:
      options.resolve ?? (() => Promise.resolve([BOOTSTRAP_ADDRESS])),
    sessionNodeId: new Uint8Array(20).fill(1)
  })
  return { boundary, deliveries, sockets, warnings }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('DhtBoundary', () => {
  it('sends no packet until a public generation activates', () => {
    const harness = createHarness()
    expect(harness.boundary.active).toBe(false)
    expect(harness.sockets).toHaveLength(0)
  })

  it('refuses a private torrent outright', async () => {
    const harness = createHarness()
    await expect(
      harness.boundary.activate({
        announcePort: 51_413,
        generationId: 'generation-1',
        infoHash: INFO_HASH,
        private: true
      })
    ).rejects.toBeInstanceOf(DhtBoundaryError)
    expect(harness.boundary.active).toBe(false)
  })

  it('queries only reviewed bootstrap addresses and announces with a token', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })

    await vi.advanceTimersByTimeAsync(1)
    const socket = harness.sockets[0]
    if (!socket) throw new Error('Expected a socket')
    expect(socket.bound).toBe(true)
    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]?.address).toBe(BOOTSTRAP_ADDRESS)
    expect(socket.sent[0]?.port).toBe(DHT_BOOTSTRAP_ENDPOINTS[0]?.port)

    const query = decodeQuery(socket.sent[0]?.message as Uint8Array)
    expect(query.method).toBe('get_peers')
    socket.deliver(peersResponse(query.transaction), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })

    await vi.advanceTimersByTimeAsync(1)
    await activation

    expect(harness.deliveries).toEqual([
      {
        generationId: 'generation-1',
        infoHash: INFO_HASH,
        peers: [{ address: PEER_ADDRESS, port: 6881 }]
      }
    ])
    const announce = socket.sent.map(entry => decodeQuery(entry.message))
    expect(announce.some(entry => entry.method === 'announce_peer')).toBe(true)
  })

  it('ignores a response from the wrong source or transaction', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)

    const socket = harness.sockets[0]
    if (!socket) throw new Error('Expected a socket')
    const query = decodeQuery(socket.sent[0]?.message as Uint8Array)

    socket.deliver(peersResponse(query.transaction), {
      address: '203.0.113.200',
      port: 6881
    })
    socket.deliver(peersResponse(query.transaction), {
      address: BOOTSTRAP_ADDRESS,
      port: 9999
    })
    socket.deliver(peersResponse(new Uint8Array([0xff, 0xfe])), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })
    expect(harness.deliveries).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DHT_BOUNDARY_LIMITS.queryTimeoutMs)
    await activation
    expect(harness.deliveries).toHaveLength(0)
    expect(harness.warnings).toContain('DHT_UNAVAILABLE')
  })

  it('drops a hostile datagram without disturbing the cycle', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)

    const socket = harness.sockets[0]
    if (!socket) throw new Error('Expected a socket')
    const query = decodeQuery(socket.sent[0]?.message as Uint8Array)

    socket.deliver(new Uint8Array(4_096), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })
    socket.deliver(new Uint8Array([0x64, 0x65]), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })
    socket.deliver(peersResponse(query.transaction), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })

    await vi.advanceTimersByTimeAsync(1)
    await activation
    expect(harness.deliveries).toHaveLength(1)
  })

  it('drops private peers and caps observations per response', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)

    const socket = harness.sockets[0]
    if (!socket) throw new Error('Expected a socket')
    const query = decodeQuery(socket.sent[0]?.message as Uint8Array)
    socket.deliver(
      peersResponse(query.transaction, {
        values: [
          compactPeer('10.1.2.3', 6881),
          compactPeer('127.0.0.1', 6881),
          compactPeer(PEER_ADDRESS, 6881)
        ]
      }),
      { address: BOOTSTRAP_ADDRESS, port: 6881 }
    )

    await vi.advanceTimersByTimeAsync(1)
    await activation
    expect(harness.deliveries[0]?.peers).toEqual([
      { address: PEER_ADDRESS, port: 6881 }
    ])
  })

  it('warns and stays quiet when no bootstrap address resolves', async () => {
    const harness = createHarness({ resolve: () => Promise.resolve([]) })
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)
    await activation

    expect(harness.sockets[0]?.sent).toHaveLength(0)
    expect(harness.warnings).toContain('DHT_UNAVAILABLE')
  })

  it('rejects private bootstrap answers before any packet', async () => {
    const harness = createHarness({
      resolve: () => Promise.resolve(['10.0.0.1', '192.168.1.1', '127.0.0.1'])
    })
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)
    await activation

    expect(harness.sockets[0]?.sent).toHaveLength(0)
  })

  it('destroys the socket when the last generation closes', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)
    const socket = harness.sockets[0]
    if (!socket) throw new Error('Expected a socket')
    const query = decodeQuery(socket.sent[0]?.message as Uint8Array)
    socket.deliver(peersResponse(query.transaction), {
      address: BOOTSTRAP_ADDRESS,
      port: 6881
    })
    await vi.advanceTimersByTimeAsync(1)
    await activation

    expect(harness.boundary.active).toBe(true)
    harness.boundary.deactivate(INFO_HASH)
    expect(harness.boundary.active).toBe(false)
    expect(socket.closed).toBe(true)
    expect(harness.boundary.activationCount).toBe(0)
  })

  it('settles every pending query exactly once on close', async () => {
    const harness = createHarness()
    const activation = harness.boundary.activate({
      announcePort: 51_413,
      generationId: 'generation-1',
      infoHash: INFO_HASH,
      private: false
    })
    await vi.advanceTimersByTimeAsync(1)

    harness.boundary.close()
    harness.boundary.close()
    await vi.advanceTimersByTimeAsync(DHT_BOUNDARY_LIMITS.queryTimeoutMs)
    await activation

    expect(harness.sockets[0]?.closed).toBe(true)
    expect(harness.deliveries).toHaveLength(0)
    expect(harness.boundary.active).toBe(false)
  })

  it('refuses to activate after close', async () => {
    const harness = createHarness()
    harness.boundary.close()

    await expect(
      harness.boundary.activate({
        announcePort: 51_413,
        generationId: 'generation-1',
        infoHash: INFO_HASH,
        private: false
      })
    ).rejects.toMatchObject({ code: 'CLOSED' })
  })
})
