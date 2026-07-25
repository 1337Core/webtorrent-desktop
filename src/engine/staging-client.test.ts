import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  StagingClientPool,
  type StagingWebTorrentClient
} from './staging-client'

class FakeClient extends EventEmitter implements StagingWebTorrentClient {
  destroyed = false
  readonly added: string[] = []
  #port: number

  constructor(port: number) {
    super()
    this.#port = port
  }

  add(uri: string): unknown {
    this.added.push(uri)
    return {}
  }

  address(): { address: string; family: string; port: number } | null {
    return this.#port > 0
      ? { address: '0.0.0.0', family: 'IPv4', port: this.#port }
      : null
  }

  destroy(callback?: (error?: Error) => void): void {
    this.destroyed = true
    callback?.()
  }
}

type Harness = {
  clients: FakeClient[]
  pool: StagingClientPool<FakeClient>
}

function harness(options: { port?: number; silent?: boolean } = {}): Harness {
  const clients: FakeClient[] = []
  const pool = new StagingClientPool<FakeClient>({
    createClient: () => {
      const client = new FakeClient(options.port ?? 51_413)
      clients.push(client)
      if (!options.silent) setTimeout(() => client.emit('listening'), 0)
      return client
    },
    listenTimeoutMs: 50
  })
  return { clients, pool }
}

describe('StagingClientPool', () => {
  it('spawns one client for concurrent leases and destroys it with the last', async () => {
    const context = harness()

    const first = await context.pool.lease()
    const second = await context.pool.lease()

    expect(context.clients).toHaveLength(1)
    expect(first.client).toBe(second.client)
    expect(first.port).toBe(51_413)
    expect(first.peerId).not.toBe(second.peerId)

    await first.release()
    // One lease remains, so the client stays.
    expect(context.clients[0]?.destroyed).toBe(false)

    await second.release()
    expect(context.clients[0]?.destroyed).toBe(true)
    expect(context.pool.leaseCount).toBe(0)
    expect(context.pool.active).toBe(false)
  })

  it('spawns a fresh client after the pool has gone idle', async () => {
    const context = harness()

    await (await context.pool.lease()).release()
    await (await context.pool.lease()).release()

    expect(context.clients).toHaveLength(2)
    expect(context.clients.every(client => client.destroyed)).toBe(true)
  })

  it('releases only once however often it is called', async () => {
    const context = harness()
    const lease = await context.pool.lease()

    await lease.release()
    await lease.release()

    expect(context.pool.leaseCount).toBe(0)
    expect(context.clients).toHaveLength(1)
  })

  it('gives up on a client that never reports a listener', async () => {
    const context = harness({ silent: true })

    await expect(context.pool.lease()).rejects.toMatchObject({
      code: 'LISTEN_TIMEOUT'
    })
    expect(context.clients[0]?.destroyed).toBe(true)
    expect(context.pool.leaseCount).toBe(0)
  })

  it('refuses a lease once closed and destroys the live client', async () => {
    const context = harness()
    const lease = await context.pool.lease()

    await context.pool.close()

    expect(context.clients[0]?.destroyed).toBe(true)
    await expect(context.pool.lease()).rejects.toMatchObject({ code: 'CLOSED' })
    // A late release from the acquisition that was running is harmless.
    await expect(lease.release()).resolves.toBeUndefined()
  })

  it('reports a client that cannot be constructed', async () => {
    const pool = new StagingClientPool({
      createClient: () => {
        throw new Error('no client')
      }
    })

    await expect(pool.lease()).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
    expect(pool.active).toBe(false)
  })

  it('never leaves an unhandled error on the staging client', async () => {
    const context = harness()
    const lease = await context.pool.lease()
    const listeners = context.clients[0]?.listenerCount('error') ?? 0

    expect(listeners).toBeGreaterThan(0)
    expect(() =>
      context.clients[0]?.emit('error', new Error('boom'))
    ).not.toThrow()

    await lease.release()
  })
})
