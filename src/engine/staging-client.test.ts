import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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
  inboundClosed: FakeClient[]
  pool: StagingClientPool<FakeClient>
}

function harness(
  options: { inboundFails?: boolean; port?: number; silent?: boolean } = {}
): Harness {
  const clients: FakeClient[] = []
  const inboundClosed: FakeClient[] = []
  const pool = new StagingClientPool<FakeClient>({
    closeInbound: async client => {
      if (options.inboundFails) throw new Error('close failed')
      inboundClosed.push(client)
    },
    createClient: () => {
      const client = new FakeClient(options.port ?? 51_413)
      clients.push(client)
      if (!options.silent) setTimeout(() => client.emit('listening'), 0)
      return client
    },
    listenTimeoutMs: 50
  })
  return { clients, inboundClosed, pool }
}

describe('StagingClientPool', () => {
  it('spawns one disposable client and identity per concurrent lease', async () => {
    const context = harness()

    const first = await context.pool.lease()
    const second = await context.pool.lease()

    expect(context.clients).toHaveLength(2)
    expect(first.client).not.toBe(second.client)
    expect(first.port).toBe(51_413)
    expect(context.inboundClosed).toEqual([first.client, second.client])

    await first.release()
    expect(context.clients[0]?.destroyed).toBe(true)
    expect(context.clients[1]?.destroyed).toBe(false)

    await second.release()
    expect(context.clients[1]?.destroyed).toBe(true)
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

  it('marks a destroy timeout unhealthy and retains the slot until callback', async () => {
    const destroy = {
      finish: null as ((error?: Error) => void) | null
    }
    const clients: FakeClient[] = []
    const unhealthy = vi.fn()
    const pool = new StagingClientPool<FakeClient>({
      createClient: () => {
        const client = new FakeClient(51_413)
        client.destroy = callback => {
          client.destroyed = true
          destroy.finish = callback ?? null
        }
        clients.push(client)
        setTimeout(() => client.emit('listening'), 0)
        return client
      },
      destroyTimeoutMs: 10,
      onUnhealthy: unhealthy
    })
    const lease = await pool.lease()

    await expect(lease.release()).rejects.toMatchObject({
      code: 'DESTROY_TIMEOUT'
    })
    expect(pool.leaseCount).toBe(1)
    expect(unhealthy).toHaveBeenCalledOnce()
    await expect(pool.lease()).rejects.toMatchObject({ code: 'UNHEALTHY' })

    if (!destroy.finish) throw new Error('Expected a destroy callback')
    destroy.finish()
    await vi.waitFor(() => expect(pool.leaseCount).toBe(0))
    expect(clients[0]?.destroyed).toBe(true)
  })

  it('accepts the listener-already-closed callback caused by the inbound guard', async () => {
    const unhealthy = vi.fn()
    const pool = new StagingClientPool<FakeClient>({
      closeInbound: async () => undefined,
      createClient: () => {
        const client = new FakeClient(51_413)
        client.destroy = callback => {
          client.destroyed = true
          callback?.(
            Object.assign(new Error('Server is not running.'), {
              code: 'ERR_SERVER_NOT_RUNNING'
            })
          )
        }
        setTimeout(() => client.emit('listening'), 0)
        return client
      },
      onUnhealthy: unhealthy
    })

    await expect((await pool.lease()).release()).resolves.toBeUndefined()
    expect(pool.leaseCount).toBe(0)
    expect(unhealthy).not.toHaveBeenCalled()
  })

  it('keeps a failed-destroy slot and marks the pool unhealthy', async () => {
    const unhealthy = vi.fn()
    const pool = new StagingClientPool<FakeClient>({
      createClient: () => {
        const client = new FakeClient(51_413)
        client.destroy = callback => {
          client.destroyed = true
          callback?.(new Error('destroy failed'))
        }
        setTimeout(() => client.emit('listening'), 0)
        return client
      },
      onUnhealthy: unhealthy
    })

    await expect((await pool.lease()).release()).rejects.toMatchObject({
      code: 'DESTROY_FAILED'
    })
    expect(pool.leaseCount).toBe(1)
    expect(unhealthy).toHaveBeenCalledOnce()
    await expect(pool.lease()).rejects.toMatchObject({ code: 'UNHEALTHY' })
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
    expect(context.pool.leaseCount).toBe(0)
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

  it('destroys a client whose inbound listener cannot be closed', async () => {
    const context = harness({ inboundFails: true })

    await expect(context.pool.lease()).rejects.toMatchObject({
      code: 'INBOUND_GUARD_FAILED'
    })
    expect(context.clients[0]?.destroyed).toBe(true)
    expect(context.pool.leaseCount).toBe(0)
  })

  it('bounds an inbound guard that never finishes', async () => {
    const clients: FakeClient[] = []
    const pool = new StagingClientPool<FakeClient>({
      closeInbound: () => new Promise(() => undefined),
      createClient: () => {
        const client = new FakeClient(51_413)
        clients.push(client)
        setTimeout(() => client.emit('listening'), 0)
        return client
      },
      inboundCloseTimeoutMs: 10
    })

    await expect(pool.lease()).rejects.toMatchObject({
      code: 'INBOUND_GUARD_FAILED'
    })
    expect(clients[0]?.destroyed).toBe(true)
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
