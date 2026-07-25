import type { WebTorrentOptions } from 'webtorrent'
import { createClientOptions, createPeerId } from './client-config'

export const CLIENT_LIFECYCLE_TIMEOUTS = Object.freeze({
  destroyMs: 4_000,
  listenMs: 15_000
})

export type EngineClientOwner = 'private' | 'public'

export type EngineClientFatalReason =
  'CLIENT_ERROR' | 'CLIENT_DESTROYED' | 'LISTENER_LOST'

export type ClientLifecycleErrorCode =
  | 'CLIENT_ERROR'
  | 'LISTEN_TIMEOUT'
  | 'NOT_READY'
  | 'SPAWN_FAILED'
  | 'STATE_CONFLICT'

export class ClientLifecycleError extends Error {
  readonly code: ClientLifecycleErrorCode

  constructor(code: ClientLifecycleErrorCode) {
    super(`Torrent client lifecycle failed: ${code}.`)
    this.name = 'ClientLifecycleError'
    this.code = code
  }
}

/**
 * The exact WebTorrent client surface this boundary consumes. Keeping it
 * structural lets the lifecycle rules be proven without opening real sockets.
 */
type EngineWebTorrentClient = {
  address(): { address: string; family: string; port: number } | null
  destroy(callback?: (error?: Error) => void): void
  destroyed: boolean
  on(event: string, listener: (...args: unknown[]) => void): unknown
  peerId: string
}

export type EngineClientFactory = (
  owner: EngineClientOwner,
  options: WebTorrentOptions
) => EngineWebTorrentClient

export type ClientLifecycleOptions = Readonly<{
  createClient: EngineClientFactory
  createPeerId?: () => Uint8Array
  destroyTimeoutMs?: number
  listenTimeoutMs?: number
  onFatal?: (owner: EngineClientOwner, reason: EngineClientFatalReason) => void
}>

export type EngineClientHandle = Readonly<{
  client: EngineWebTorrentClient
  owner: EngineClientOwner
  peerId: Uint8Array
  port: number
}>

export type ClientCloseFailure = Readonly<{
  owner: EngineClientOwner
  reason: 'DESTROY_FAILED' | 'DESTROY_TIMEOUT'
}>

export type ClientCloseReport = Readonly<{
  destroyed: ReadonlyArray<EngineClientOwner>
  failures: ReadonlyArray<ClientCloseFailure>
}>

type ManagedClient = {
  client: EngineWebTorrentClient
  listening: boolean
  owner: EngineClientOwner
  peerId: Uint8Array
  port: number
}

const OWNERS: ReadonlyArray<EngineClientOwner> = ['public', 'private']

/**
 * Owns the two long-lived WebTorrent clients for one engine generation.
 *
 * Both clients are created once, must both report `listening` before any
 * torrent may be added, and are destroyed in one recorded teardown. Client
 * error handling is attached before any asynchronous work so an early failure
 * cannot escape as an unhandled event.
 */
export class EngineClientLifecycle {
  readonly #createClient: EngineClientFactory
  readonly #createPeerId: () => Uint8Array
  readonly #destroyTimeoutMs: number
  readonly #listenTimeoutMs: number
  readonly #managed = new Map<EngineClientOwner, ManagedClient>()
  readonly #onFatal: (
    owner: EngineClientOwner,
    reason: EngineClientFatalReason
  ) => void
  #closePromise: Promise<ClientCloseReport> | null = null
  #ready = false
  #startPromise: Promise<void> | null = null

  constructor(options: ClientLifecycleOptions) {
    this.#createClient = options.createClient
    this.#createPeerId = options.createPeerId ?? createPeerId
    this.#destroyTimeoutMs =
      options.destroyTimeoutMs ?? CLIENT_LIFECYCLE_TIMEOUTS.destroyMs
    this.#listenTimeoutMs =
      options.listenTimeoutMs ?? CLIENT_LIFECYCLE_TIMEOUTS.listenMs
    this.#onFatal = options.onFatal ?? (() => undefined)
  }

  /** Additions stay closed until both clients own a live listener. */
  get ready(): boolean {
    return this.#ready
  }

  /** A closed generation is never restarted; the engine builds a new one. */
  start(): Promise<void> {
    if (this.#closePromise) {
      return Promise.reject(new ClientLifecycleError('STATE_CONFLICT'))
    }
    this.#startPromise ??= this.#startOnce()
    return this.#startPromise
  }

  handle(owner: EngineClientOwner): EngineClientHandle {
    const managed = this.#managed.get(owner)
    if (!this.#ready || !managed) {
      throw new ClientLifecycleError('NOT_READY')
    }
    return {
      client: managed.client,
      owner: managed.owner,
      peerId: managed.peerId.slice(),
      port: managed.port
    }
  }

  close(): Promise<ClientCloseReport> {
    this.#closePromise ??= this.#closeOnce()
    return this.#closePromise
  }

  async #startOnce(): Promise<void> {
    if (this.#closePromise) throw new ClientLifecycleError('STATE_CONFLICT')

    try {
      for (const owner of OWNERS) this.#spawn(owner)
      await Promise.all(
        [...this.#managed.values()].map(managed =>
          this.#awaitListening(managed)
        )
      )
    } catch (error) {
      await this.close()
      throw error instanceof ClientLifecycleError
        ? error
        : new ClientLifecycleError('SPAWN_FAILED')
    }

    if (this.#closePromise) throw new ClientLifecycleError('STATE_CONFLICT')
    this.#ready = true
  }

  #spawn(owner: EngineClientOwner): void {
    const peerId = this.#createPeerId()
    let client: EngineWebTorrentClient
    try {
      client = this.#createClient(owner, createClientOptions(owner, { peerId }))
    } catch {
      throw new ClientLifecycleError('SPAWN_FAILED')
    }

    const managed: ManagedClient = {
      client,
      listening: false,
      owner,
      peerId,
      port: 0
    }
    this.#managed.set(owner, managed)

    // Attached before any await so a synchronous constructor failure, or an
    // error emitted during the listening wait, is always observed.
    client.on('error', () => {
      managed.listening = false
      if (this.#ready) this.#onFatal(owner, 'CLIENT_ERROR')
    })
    client.on('close', () => {
      if (!this.#ready || this.#closePromise) return
      managed.listening = false
      this.#onFatal(owner, 'CLIENT_DESTROYED')
    })
  }

  async #awaitListening(managed: ManagedClient): Promise<void> {
    const port = await new Promise<number>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new ClientLifecycleError('LISTEN_TIMEOUT'))
      }, this.#listenTimeoutMs)
      timer.unref()

      managed.client.on('listening', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(managed.client.address()?.port ?? 0)
      })
      managed.client.on('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new ClientLifecycleError('CLIENT_ERROR'))
      })
    })

    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new ClientLifecycleError('CLIENT_ERROR')
    }
    managed.listening = true
    managed.port = port
  }

  async #closeOnce(): Promise<ClientCloseReport> {
    this.#ready = false
    const destroyed: EngineClientOwner[] = []
    const failures: ClientCloseFailure[] = []

    // Teardown continues through a failing client so the second one is never
    // left running, and each failing phase is reported to engine health.
    for (const owner of OWNERS) {
      const managed = this.#managed.get(owner)
      if (!managed) continue
      const failure = await this.#destroy(managed)
      if (failure) failures.push(failure)
      else destroyed.push(owner)
    }
    this.#managed.clear()

    return { destroyed, failures }
  }

  #destroy(managed: ManagedClient): Promise<ClientCloseFailure | null> {
    return new Promise<ClientCloseFailure | null>(resolve => {
      let settled = false
      const finish = (failure: ClientCloseFailure | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(failure)
      }
      const timer = setTimeout(() => {
        finish({ owner: managed.owner, reason: 'DESTROY_TIMEOUT' })
      }, this.#destroyTimeoutMs)
      timer.unref()

      try {
        managed.client.destroy(error => {
          finish(
            error ? { owner: managed.owner, reason: 'DESTROY_FAILED' } : null
          )
        })
      } catch {
        finish({ owner: managed.owner, reason: 'DESTROY_FAILED' })
      }
    })
  }
}
