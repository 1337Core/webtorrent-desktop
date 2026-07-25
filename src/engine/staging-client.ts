import { createClientOptions, createPeerId } from './client-config'
import type { WebTorrentOptions } from 'webtorrent'

const STAGING_CLIENT_TIMEOUTS = Object.freeze({
  destroyMs: 4_000,
  inboundCloseMs: 1_000,
  listenMs: 15_000
} as const)

type StagingClientErrorCode =
  | 'CLOSED'
  | 'DESTROY_FAILED'
  | 'DESTROY_TIMEOUT'
  | 'INBOUND_GUARD_FAILED'
  | 'LISTEN_TIMEOUT'
  | 'SPAWN_FAILED'
  | 'UNHEALTHY'

class StagingClientError extends Error {
  readonly code: StagingClientErrorCode

  constructor(code: StagingClientErrorCode) {
    super(`Staging client failed: ${code}.`)
    this.name = 'StagingClientError'
    this.code = code
  }
}

/** The exact staging client surface metadata acquisition consumes. */
export type StagingWebTorrentClient = {
  add(uri: string, options: Record<string, unknown>): unknown
  address(): { address: string; family: string; port: number } | null
  destroy(callback?: (error?: Error) => void): void
  destroyed: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export type StagingClientLease<TClient> = Readonly<{
  client: TClient
  peerId: Uint8Array
  port: number
  release: () => Promise<void>
}>

export type StagingClientPoolOptions<TClient extends StagingWebTorrentClient> =
  Readonly<{
    closeInbound?: (client: TClient) => Promise<void>
    createClient: (options: WebTorrentOptions) => TClient
    createPeerId?: () => Uint8Array
    destroyTimeoutMs?: number
    inboundCloseTimeoutMs?: number
    listenTimeoutMs?: number
    onUnhealthy?: (error: Error) => void
  }>

/**
 * The engine's staging client, created only while metadata is being acquired.
 *
 * Staging is not a long-lived participant: it exists to fetch one or two info
 * dictionaries and then stop. The client is spawned on the first lease,
 * Each acquisition gets a disposable client and identity. At most two clients
 * may exist at once, matching the acquisition-wide concurrency ceiling, and a
 * lease destroys its own client as soon as it is released.
 */
export class StagingClientPool<
  TClient extends StagingWebTorrentClient = StagingWebTorrentClient
> {
  readonly #options: StagingClientPoolOptions<TClient>
  readonly #active = new Set<
    Promise<{
      client: TClient
      peerId: Uint8Array
      port: number
    }>
  >()
  readonly #destroying = new WeakMap<
    TClient,
    Readonly<{
      bounded: Promise<void>
      completed: Promise<Error | undefined>
    }>
  >()
  #closed = false
  #unhealthy = false

  constructor(options: StagingClientPoolOptions<TClient>) {
    this.#options = options
  }

  get leaseCount(): number {
    return this.#active.size
  }

  get active(): boolean {
    return this.#active.size > 0
  }

  async lease(): Promise<StagingClientLease<TClient>> {
    if (this.#closed) throw new StagingClientError('CLOSED')
    if (this.#unhealthy) throw new StagingClientError('UNHEALTHY')
    if (this.#active.size >= 2) throw new StagingClientError('SPAWN_FAILED')
    const starting = this.#spawn()
    this.#active.add(starting)
    let started
    try {
      started = await starting
    } catch (error) {
      if (!this.#unhealthy) this.#active.delete(starting)
      throw error
    }
    if (this.#closed) {
      await this.#releaseClient(starting, started.client)
      throw new StagingClientError('CLOSED')
    }

    let releasePromise: Promise<void> | null = null
    return {
      client: started.client,
      peerId: started.peerId.slice(),
      port: started.port,
      release: async () => {
        releasePromise ??= this.#releaseClient(starting, started.client)
        await releasePromise
      }
    }
  }

  /** Destroys the client immediately, whatever leases remain. */
  async close(): Promise<void> {
    this.#closed = true
    const active = [...this.#active]
    const results = await Promise.allSettled(
      active.map(async starting =>
        this.#releaseClient(starting, (await starting).client)
      )
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) throw failure.reason
  }

  async #spawn(): Promise<{
    client: TClient
    peerId: Uint8Array
    port: number
  }> {
    const peerId = (this.#options.createPeerId ?? createPeerId)()
    let client: TClient
    try {
      client = this.#options.createClient(
        createClientOptions('staging', { peerId })
      )
    } catch {
      throw new StagingClientError('SPAWN_FAILED')
    }
    // Attached before the wait so an early failure is never unhandled.
    client.on('error', () => undefined)

    const port = await new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (value: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (value === null) reject(new StagingClientError('LISTEN_TIMEOUT'))
        else resolve(value)
      }
      const timer = setTimeout(
        () => finish(null),
        this.#options.listenTimeoutMs ?? STAGING_CLIENT_TIMEOUTS.listenMs
      )
      timer.unref?.()
      client.on('listening', () => {
        const address = client.address()
        finish(address && address.port > 0 ? address.port : null)
      })
      client.on('error', () => finish(null))
    }).catch(async error => {
      await this.#destroy(client).bounded
      throw error
    })

    if (this.#options.closeInbound) {
      try {
        await this.#within(
          this.#options.closeInbound(client),
          this.#options.inboundCloseTimeoutMs ??
            STAGING_CLIENT_TIMEOUTS.inboundCloseMs
        )
      } catch {
        await this.#destroy(client).bounded
        throw new StagingClientError('INBOUND_GUARD_FAILED')
      }
    }

    return { client, peerId, port }
  }

  async #releaseClient(
    starting: Promise<{ client: TClient; peerId: Uint8Array; port: number }>,
    client: TClient
  ): Promise<void> {
    const teardown = this.#destroy(client)
    void teardown.completed.then(() => {
      this.#active.delete(starting)
    })
    await teardown.bounded
  }

  #destroy(client: TClient): Readonly<{
    bounded: Promise<void>
    completed: Promise<Error | undefined>
  }> {
    const existing = this.#destroying.get(client)
    if (existing) return existing
    if (client.destroyed) {
      const error = new StagingClientError('DESTROY_FAILED')
      this.#markUnhealthy(error)
      const completed = new Promise<Error | undefined>(() => undefined)
      const state = {
        bounded: Promise.reject(error),
        completed
      }
      this.#destroying.set(client, state)
      return state
    }

    const completion = Promise.withResolvers<Error | undefined>()
    let timer: NodeJS.Timeout | null = null
    let rejectDestroy = (): void => undefined
    const bounded = new Promise<void>((resolve, reject) => {
      rejectDestroy = () => reject(new StagingClientError('DESTROY_FAILED'))
      timer = setTimeout(() => {
        const error = new StagingClientError('DESTROY_TIMEOUT')
        this.#markUnhealthy(error)
        reject(error)
      }, this.#options.destroyTimeoutMs ?? STAGING_CLIENT_TIMEOUTS.destroyMs)
      timer.unref?.()
      void completion.promise.then(error => {
        if (timer) clearTimeout(timer)
        if (error) {
          const failure = new StagingClientError('DESTROY_FAILED')
          this.#markUnhealthy(failure)
          reject(failure)
        } else {
          resolve()
        }
      })
    })
    const state = { bounded, completed: completion.promise }
    this.#destroying.set(client, state)
    try {
      client.destroy(error => completion.resolve(error))
    } catch {
      if (timer) clearTimeout(timer)
      this.#markUnhealthy(new StagingClientError('DESTROY_FAILED'))
      rejectDestroy()
    }
    return state
  }

  async #within(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StagingClientError('INBOUND_GUARD_FAILED')),
        timeoutMs
      )
      timer.unref?.()
    })
    try {
      await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #markUnhealthy(error: Error): void {
    if (this.#unhealthy) return
    this.#unhealthy = true
    this.#options.onUnhealthy?.(error)
  }
}
