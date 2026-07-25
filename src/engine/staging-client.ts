import { createClientOptions, createPeerId } from './client-config'
import type { WebTorrentOptions } from 'webtorrent'

const STAGING_CLIENT_TIMEOUTS = Object.freeze({
  destroyMs: 4_000,
  listenMs: 15_000
} as const)

type StagingClientErrorCode = 'CLOSED' | 'LISTEN_TIMEOUT' | 'SPAWN_FAILED'

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
    createClient: (options: WebTorrentOptions) => TClient
    createPeerId?: () => Uint8Array
    destroyTimeoutMs?: number
    listenTimeoutMs?: number
  }>

/**
 * The engine's staging client, created only while metadata is being acquired.
 *
 * Staging is not a long-lived participant: it exists to fetch one or two info
 * dictionaries and then stop. The client is spawned on the first lease,
 * shared by concurrent acquisitions, and destroyed as soon as the last lease
 * is released, so an idle engine holds no staging listener at all.
 */
export class StagingClientPool<
  TClient extends StagingWebTorrentClient = StagingWebTorrentClient
> {
  readonly #options: StagingClientPoolOptions<TClient>
  #closed = false
  #leases = 0
  #starting: Promise<{
    client: TClient
    peerId: Uint8Array
    port: number
  }> | null = null

  constructor(options: StagingClientPoolOptions<TClient>) {
    this.#options = options
  }

  get leaseCount(): number {
    return this.#leases
  }

  get active(): boolean {
    return this.#starting !== null
  }

  async lease(): Promise<StagingClientLease<TClient>> {
    if (this.#closed) throw new StagingClientError('CLOSED')
    this.#leases += 1
    let started
    try {
      this.#starting ??= this.#spawn()
      started = await this.#starting
    } catch (error) {
      this.#leases -= 1
      await this.#stopIfIdle()
      throw error
    }
    if (this.#closed) {
      this.#leases -= 1
      await this.#stopIfIdle()
      throw new StagingClientError('CLOSED')
    }

    let released = false
    return {
      client: started.client,
      peerId: started.peerId.slice(),
      port: started.port,
      release: async () => {
        if (released) return
        released = true
        this.#leases -= 1
        await this.#stopIfIdle()
      }
    }
  }

  /** Destroys the client immediately, whatever leases remain. */
  async close(): Promise<void> {
    this.#closed = true
    this.#leases = 0
    await this.#stopIfIdle()
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
      await this.#destroy(client)
      throw error
    })

    return { client, peerId, port }
  }

  async #stopIfIdle(): Promise<void> {
    if (this.#leases > 0) return
    const starting = this.#starting
    this.#starting = null
    if (!starting) return
    try {
      const started = await starting
      await this.#destroy(started.client)
    } catch {
      // A client that never started has nothing left to destroy.
    }
  }

  async #destroy(client: TClient): Promise<void> {
    if (client.destroyed) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(
        () => resolve(),
        this.#options.destroyTimeoutMs ?? STAGING_CLIENT_TIMEOUTS.destroyMs
      )
      timer.unref?.()
      try {
        client.destroy(() => {
          clearTimeout(timer)
          resolve()
        })
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}
