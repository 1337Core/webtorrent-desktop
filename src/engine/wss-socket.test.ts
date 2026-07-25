import { describe, expect, it, vi } from 'vitest'
import { EgressPolicy } from './network-policy'
import type { WssSocket } from './wss-tracker'
import {
  WSS_SOCKET_LIMITS,
  WssSocketError,
  WssSocketFactory
} from './wss-socket'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const TRACKER = 'wss://tracker.example/announce'

type Listeners = Map<string, Array<(...args: unknown[]) => void>>

function fakeSocket(): { listeners: Listeners; socket: WssSocket } {
  const listeners: Listeners = new Map()
  const socket = {
    bufferedAmount: 0,
    close: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return socket
    },
    send: vi.fn(),
    terminate: vi.fn()
  } as unknown as WssSocket
  return { listeners, socket }
}

function policy(): EgressPolicy {
  return new EgressPolicy({
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }]
  })
}

function harness(): {
  created: Array<{ options: Record<string, unknown>; url: string }>
  factory: WssSocketFactory
  sockets: Array<{ listeners: Listeners; socket: WssSocket }>
} {
  const created: Array<{ options: Record<string, unknown>; url: string }> = []
  const sockets: Array<{ listeners: Listeners; socket: WssSocket }> = []
  const factory = new WssSocketFactory({
    createSocket: (url, options) => {
      created.push({
        options: options as unknown as Record<string, unknown>,
        url
      })
      const next = fakeSocket()
      sockets.push(next)
      return next.socket
    },
    policy: policy()
  })
  return { created, factory, sockets }
}

describe('WssSocketFactory', () => {
  it('connects to the approved address while presenting the original name', async () => {
    const context = harness()

    await context.factory.connect({ infoHash: INFO_HASH, url: TRACKER })

    const call = context.created[0]
    expect(call?.url).toBe('wss://tracker.example/announce')
    expect(call?.options).toMatchObject({
      ALPNProtocols: ['http/1.1'],
      followRedirects: false,
      handshakeTimeout: WSS_SOCKET_LIMITS.handshakeMs,
      host: 'tracker.example',
      maxPayload: WSS_SOCKET_LIMITS.maxMessageBytes,
      minVersion: 'TLSv1.2',
      origin: undefined,
      perMessageDeflate: false,
      servername: 'tracker.example'
    })
  })

  it('resolves the endpoint once and never asks the resolver again', async () => {
    const context = harness()
    await context.factory.connect({ infoHash: INFO_HASH, url: TRACKER })

    const lookup = context.created[0]?.options.lookup as (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void
    ) => void
    const seen: Array<[string, number]> = []
    lookup('tracker.example', {}, (_error, address, family) => {
      seen.push([address, family])
    })

    expect(seen).toEqual([['93.184.216.34', 4]])
  })

  it('refuses cleartext WebSocket and every other scheme', async () => {
    const context = harness()

    await expect(
      context.factory.connect({
        infoHash: INFO_HASH,
        url: 'ws://tracker.example/announce'
      })
    ).rejects.toThrow(WssSocketError)
    await expect(
      context.factory.connect({
        infoHash: INFO_HASH,
        url: 'https://tracker.example/announce'
      })
    ).rejects.toThrow(WssSocketError)
    expect(context.factory.openSocketCount).toBe(0)
  })

  it('refuses a tracker that resolves to a blocked address', async () => {
    const factory = new WssSocketFactory({
      createSocket: () => fakeSocket().socket,
      policy: new EgressPolicy({
        dnsLookup: async () => [{ address: '192.168.1.10', family: 4 }]
      })
    })

    await expect(
      factory.connect({ infoHash: INFO_HASH, url: TRACKER })
    ).rejects.toThrow(WssSocketError)
    expect(factory.openSocketCount).toBe(0)
  })

  it('holds one slot per torrent and stops at the per-torrent budget', async () => {
    const context = harness()

    for (
      let index = 0;
      index < WSS_SOCKET_LIMITS.maxSocketsPerTorrent;
      index++
    ) {
      await context.factory.connect({ infoHash: INFO_HASH, url: TRACKER })
    }

    expect(context.factory.socketCountFor(INFO_HASH)).toBe(
      WSS_SOCKET_LIMITS.maxSocketsPerTorrent
    )
    await expect(
      context.factory.connect({ infoHash: INFO_HASH, url: TRACKER })
    ).rejects.toThrow(WssSocketError)
  })

  it('stops at the engine-wide budget across torrents', async () => {
    const context = harness()
    const hashes = ['a', 'b', 'c'].map(character => character.repeat(40))

    for (const infoHash of hashes) {
      for (let index = 0; index < 3; index++) {
        if (context.factory.openSocketCount >= WSS_SOCKET_LIMITS.maxSockets) {
          break
        }
        await context.factory.connect({ infoHash, url: TRACKER })
      }
    }

    expect(context.factory.openSocketCount).toBe(WSS_SOCKET_LIMITS.maxSockets)
    await expect(
      context.factory.connect({ infoHash: 'd'.repeat(40), url: TRACKER })
    ).rejects.toThrow(WssSocketError)
  })

  it('returns a slot when the socket closes, and only once', async () => {
    const context = harness()
    await context.factory.connect({ infoHash: INFO_HASH, url: TRACKER })
    expect(context.factory.openSocketCount).toBe(1)

    for (const listener of context.sockets[0]?.listeners.get('close') ?? []) {
      listener()
    }
    for (const listener of context.sockets[0]?.listeners.get('error') ?? []) {
      listener(new Error('after close'))
    }

    expect(context.factory.openSocketCount).toBe(0)
    expect(context.factory.socketCountFor(INFO_HASH)).toBe(0)
  })

  it('returns the slot when the socket cannot be constructed', async () => {
    const factory = new WssSocketFactory({
      createSocket: () => {
        throw new Error('no transport')
      },
      policy: policy()
    })

    await expect(
      factory.connect({ infoHash: INFO_HASH, url: TRACKER })
    ).rejects.toThrow(WssSocketError)
    expect(factory.openSocketCount).toBe(0)
  })
})
