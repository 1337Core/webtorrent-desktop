import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebTorrentOptions } from 'webtorrent'
import {
  ClientLifecycleError,
  CLIENT_LIFECYCLE_TIMEOUTS,
  EngineClientLifecycle,
  type EngineClientFatalReason,
  type EngineClientOwner
} from './client-lifecycle'

class FakeClient extends EventEmitter {
  destroyed = false
  peerId = '0'.repeat(40)
  destroyCalls = 0
  destroyBehavior: 'callback' | 'error' | 'hang' | 'throw' = 'callback'
  #port: number

  constructor(port: number) {
    super()
    this.#port = port
  }

  address(): { address: string; family: string; port: number } | null {
    return this.#port === 0
      ? null
      : { address: '0.0.0.0', family: 'IPv4', port: this.#port }
  }

  destroy(callback?: (error?: Error) => void): void {
    this.destroyCalls += 1
    if (this.destroyBehavior === 'throw') throw new Error('destroy threw')
    if (this.destroyBehavior === 'hang') return
    this.destroyed = true
    callback?.(
      this.destroyBehavior === 'error' ? new Error('destroy failed') : undefined
    )
  }

  listen(): void {
    this.emit('listening')
  }
}

type Harness = {
  clients: Map<EngineClientOwner, FakeClient>
  fatal: Array<{ owner: EngineClientOwner; reason: EngineClientFatalReason }>
  lifecycle: EngineClientLifecycle
  options: Map<EngineClientOwner, WebTorrentOptions>
}

function createHarness(ports: Record<EngineClientOwner, number>): Harness {
  const clients = new Map<EngineClientOwner, FakeClient>()
  const options = new Map<EngineClientOwner, WebTorrentOptions>()
  const fatal: Array<{
    owner: EngineClientOwner
    reason: EngineClientFatalReason
  }> = []
  const lifecycle = new EngineClientLifecycle({
    createClient: (owner, clientOptions) => {
      options.set(owner, clientOptions)
      const client = new FakeClient(ports[owner])
      clients.set(owner, client)
      return client
    },
    onFatal: (owner, reason) => fatal.push({ owner, reason })
  })
  return { clients, fatal, lifecycle, options }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('EngineClientLifecycle', () => {
  it('opens additions only after both clients own a distinct listener', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    await vi.advanceTimersByTimeAsync(1)

    expect(harness.lifecycle.ready).toBe(false)
    expect(() => harness.lifecycle.handle('public')).toThrow(
      ClientLifecycleError
    )

    harness.clients.get('public')?.listen()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.lifecycle.ready).toBe(false)

    harness.clients.get('private')?.listen()
    await started

    expect(harness.lifecycle.ready).toBe(true)
    const publicHandle = harness.lifecycle.handle('public')
    const privateHandle = harness.lifecycle.handle('private')
    expect(publicHandle.port).toBe(51_413)
    expect(privateHandle.port).toBe(51_414)
    expect(publicHandle.port).not.toBe(privateHandle.port)
    expect(publicHandle.peerId).not.toEqual(privateHandle.peerId)
    expect(publicHandle.peerId).toHaveLength(20)
  })

  it('creates both clients with tracker, DHT, and discovery disabled', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.listen()
    harness.clients.get('private')?.listen()
    await started

    for (const owner of ['public', 'private'] as const) {
      expect(harness.options.get(owner)).toMatchObject({
        dht: false,
        lsd: false,
        natPmp: false,
        natUpnp: false,
        secure: 1,
        tracker: false,
        utp: false,
        webSeeds: false
      })
    }
    expect(harness.options.get('private')).toMatchObject({ utPex: false })
    expect(harness.options.get('public')).toMatchObject({ utPex: true })
  })

  it('destroys both clients when one fails before listening', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.emit('error', new Error('bind failed'))

    await expect(started).rejects.toMatchObject({ code: 'CLIENT_ERROR' })
    expect(harness.lifecycle.ready).toBe(false)
    expect(harness.clients.get('public')?.destroyCalls).toBe(1)
    expect(harness.clients.get('private')?.destroyCalls).toBe(1)
    expect(harness.fatal).toHaveLength(0)
  })

  it('fails closed when a client never reports its listener', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    const rejection = expect(started).rejects.toMatchObject({
      code: 'LISTEN_TIMEOUT'
    })
    harness.clients.get('public')?.listen()

    await vi.advanceTimersByTimeAsync(CLIENT_LIFECYCLE_TIMEOUTS.listenMs)
    await rejection
    expect(harness.lifecycle.ready).toBe(false)
  })

  it('treats a lost listener or client error after start as engine-fatal', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.listen()
    harness.clients.get('private')?.listen()
    await started

    harness.clients.get('public')?.emit('error', new Error('pool destroyed'))
    harness.clients.get('private')?.emit('close')

    expect(harness.fatal).toEqual([
      { owner: 'public', reason: 'CLIENT_ERROR' },
      { owner: 'private', reason: 'CLIENT_DESTROYED' }
    ])
  })

  it('reports a failing destroy and still tears the other client down', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.listen()
    harness.clients.get('private')?.listen()
    await started

    const publicClient = harness.clients.get('public')
    const privateClient = harness.clients.get('private')
    if (!publicClient || !privateClient) throw new Error('Expected clients')
    publicClient.destroyBehavior = 'error'

    const report = await harness.lifecycle.close()
    expect(report.failures).toEqual([
      { owner: 'public', reason: 'DESTROY_FAILED' }
    ])
    expect(report.destroyed).toEqual(['private'])
    expect(privateClient.destroyed).toBe(true)
    expect(harness.lifecycle.ready).toBe(false)
  })

  it('records a hung destroy callback within its own bound', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.listen()
    harness.clients.get('private')?.listen()
    await started

    const publicClient = harness.clients.get('public')
    if (!publicClient) throw new Error('Expected the public client')
    publicClient.destroyBehavior = 'hang'

    const closing = harness.lifecycle.close()
    await vi.advanceTimersByTimeAsync(CLIENT_LIFECYCLE_TIMEOUTS.destroyMs)
    const report = await closing

    expect(report.failures).toEqual([
      { owner: 'public', reason: 'DESTROY_TIMEOUT' }
    ])
    expect(report.destroyed).toEqual(['private'])
  })

  it('closes idempotently and refuses a restart', async () => {
    const harness = createHarness({ private: 51_414, public: 51_413 })
    const started = harness.lifecycle.start()
    harness.clients.get('public')?.listen()
    harness.clients.get('private')?.listen()
    await started

    const first = harness.lifecycle.close()
    expect(harness.lifecycle.close()).toBe(first)
    await first

    expect(harness.clients.get('public')?.destroyCalls).toBe(1)
    expect(() => harness.lifecycle.handle('private')).toThrow(
      ClientLifecycleError
    )
    await expect(harness.lifecycle.start()).rejects.toMatchObject({
      code: 'STATE_CONFLICT'
    })
    expect(harness.lifecycle.ready).toBe(false)
  })
})
