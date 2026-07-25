import { canonicalInfoIdentity, TorrentInputError } from './torrent-metadata'
import { MetadataOnlyChunkStore } from './metadata-store'
import type { PreparedMagnet } from './torrent-metadata'
import { addPeerTracked } from './webtorrent-peer-adapter'

export const METADATA_ACQUISITION_LIMITS = Object.freeze({
  /** Acquisitions running at once, engine-wide. */
  maxConcurrent: 2,
  /** One acquisition's whole budget, from add to metadata. */
  timeoutMs: 120_000,
  /** Torrent teardown cannot hold the staging client forever. */
  destroyTimeoutMs: 4_000
} as const)

type MetadataAcquisitionErrorCode =
  | 'ABORTED'
  | 'BINDING_MISMATCH'
  | 'CAPACITY_EXCEEDED'
  | 'CLOSED'
  | 'DISCOVERY_FAILED'
  | 'STAGING_UNAVAILABLE'
  | 'TEARDOWN_FAILED'
  | 'TIMED_OUT'
  | 'TORRENT_ERROR'

/** Exported once a caller catches these; the codes travel in the message. */
class MetadataAcquisitionError extends Error {
  readonly code: MetadataAcquisitionErrorCode

  constructor(code: MetadataAcquisitionErrorCode) {
    super(`Metadata acquisition failed: ${code}.`)
    this.name = 'MetadataAcquisitionError'
    this.code = code
  }
}

/** The exact staging surface this acquisition uses. */
export type AcquisitionTorrent = {
  addPeer(peer: unknown, source?: string): unknown
  readonly destroyed?: boolean
  destroy(
    options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removePeer?(peer: unknown): void
  readonly torrentFile?: Uint8Array
}

export type AcquisitionClient = {
  add(uri: string, options: Record<string, unknown>): AcquisitionTorrent
}

/**
 * One staging client held for the length of a single acquisition. The lease
 * is released in the same teardown that destroys the staging torrent, so an
 * idle engine keeps no staging listener.
 */
type AcquisitionLease = Readonly<{
  client: AcquisitionClient
  /** The staging client's own identity, which its announces must carry. */
  peerId: Uint8Array
  port: number
  release: () => Promise<void>
}>

/**
 * Starts app-owned discovery for one acquisition and resolves to its stop
 * function. Trackers and, only with consent, the DHT are reached through the
 * same mediated boundaries an owned torrent uses; nothing here talks to the
 * network itself.
 */
type MetadataDiscoveryControl = Readonly<{
  /** Synchronously closes every discovery admission path. */
  freeze: () => void
  /** Reports asynchronous startup failures without delaying freeze access. */
  ready: Promise<void>
  /** Completes bounded stopped/transport cleanup. */
  stop: () => Promise<void>
}>

type MetadataDiscovery = (
  input: Readonly<{
    admitPeer: (peer: unknown) => unknown
    allowDht: boolean
    infoHash: string
    peerId: Uint8Array
    port: number
    removePeer: (peer: unknown) => void
    retirePeers: () => void
    trackers: ReadonlyArray<string>
  }>
) => MetadataDiscoveryControl

export type MetadataAcquisitionOptions = Readonly<{
  discover: MetadataDiscovery
  destroyTimeoutMs?: number
  onUnhealthy?: (error: Error) => void
  openStaging: () => Promise<AcquisitionLease>
  timeoutMs?: number
}>

/**
 * Acquires one torrent's metadata for a magnet or info hash.
 *
 * Nothing here is a durable torrent: the staging torrent exists only long
 * enough to receive the info dictionary, is destroyed with its store inside
 * the `metadata` handler, and its bytes are bound to the info hash the user
 * actually asked for before anything downstream sees them. At most two
 * acquisitions run at once.
 */
export class MetadataAcquisition {
  readonly #options: MetadataAcquisitionOptions
  readonly #controllers = new Set<AbortController>()
  #active = 0
  #closed = false
  #unhealthy = false

  constructor(options: MetadataAcquisitionOptions) {
    this.#options = options
  }

  get activeCount(): number {
    return this.#active
  }

  close(): void {
    this.#closed = true
    for (const controller of this.#controllers) controller.abort()
  }

  async acquire(
    prepared: PreparedMagnet,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (this.#closed) throw new MetadataAcquisitionError('CLOSED')
    if (this.#unhealthy) {
      throw new MetadataAcquisitionError('TEARDOWN_FAILED')
    }
    if (this.#active >= METADATA_ACQUISITION_LIMITS.maxConcurrent) {
      throw new MetadataAcquisitionError('CAPACITY_EXCEEDED')
    }
    if (signal?.aborted) throw new MetadataAcquisitionError('ABORTED')

    const controller = new AbortController()
    this.#controllers.add(controller)
    const effectiveSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    this.#active += 1
    const slot = { deferred: null as Promise<void> | null }
    try {
      return await this.#run(prepared, effectiveSignal, completion => {
        slot.deferred = completion
      })
    } finally {
      this.#controllers.delete(controller)
      const releaseSlot = (): void => {
        this.#active -= 1
      }
      if (slot.deferred) {
        void slot.deferred.then(releaseSlot, (error: unknown) => {
          this.#markUnhealthy(error)
        })
      } else {
        releaseSlot()
      }
    }
  }

  async #run(
    prepared: PreparedMagnet,
    signal: AbortSignal | undefined,
    deferSlotRelease: (completion: Promise<void>) => void
  ): Promise<Uint8Array> {
    let lease: AcquisitionLease
    try {
      lease = await this.#options.openStaging()
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? Reflect.get(error, 'code')
          : null
      if (
        code === 'DESTROY_FAILED' ||
        code === 'DESTROY_TIMEOUT' ||
        code === 'UNHEALTHY'
      ) {
        this.#markUnhealthy(error)
        deferSlotRelease(new Promise(() => undefined))
        throw new MetadataAcquisitionError('TEARDOWN_FAILED')
      }
      throw new MetadataAcquisitionError('STAGING_UNAVAILABLE')
    }

    if (signal?.aborted || this.#closed) {
      try {
        await lease.release()
      } catch (error) {
        this.#markUnhealthy(error)
        deferSlotRelease(new Promise(() => undefined))
        throw new MetadataAcquisitionError('TEARDOWN_FAILED')
      }
      throw new MetadataAcquisitionError(signal?.aborted ? 'ABORTED' : 'CLOSED')
    }

    let torrent: AcquisitionTorrent
    try {
      torrent = lease.client.add(prepared.magnetUri, {
        announce: [],
        deselect: true,
        destroyStoreOnDestroy: true,
        store: MetadataOnlyChunkStore,
        storeCacheSlots: 0
      })
    } catch {
      try {
        await lease.release()
      } catch (error) {
        this.#markUnhealthy(error)
        deferSlotRelease(new Promise(() => undefined))
        throw new MetadataAcquisitionError('TEARDOWN_FAILED')
      }
      throw new MetadataAcquisitionError('TORRENT_ERROR')
    }

    let discovery: MetadataDiscoveryControl | null = null
    let destroyState: Readonly<{
      bounded: Promise<void>
      completed: Promise<Error | undefined>
    }> | null = null
    const destroyTorrent = (): Readonly<{
      bounded: Promise<void>
      completed: Promise<Error | undefined>
    }> => {
      if (destroyState) return destroyState
      if (torrent.destroyed) {
        const completed = new Promise<Error | undefined>(() => undefined)
        destroyState = {
          bounded: Promise.reject(
            new MetadataAcquisitionError('TEARDOWN_FAILED')
          ),
          completed
        }
        return destroyState
      }
      const completion = Promise.withResolvers<Error | undefined>()
      let timer: NodeJS.Timeout | null = null
      let rejectDestroy = (): void => undefined
      const bounded = new Promise<void>((resolve, reject) => {
        rejectDestroy = () =>
          reject(new MetadataAcquisitionError('TEARDOWN_FAILED'))
        timer = setTimeout(() => {
          reject(new MetadataAcquisitionError('TEARDOWN_FAILED'))
        }, this.#options.destroyTimeoutMs ?? METADATA_ACQUISITION_LIMITS.destroyTimeoutMs)
        timer.unref?.()
        void completion.promise.then(error => {
          if (timer) clearTimeout(timer)
          if (error) reject(new MetadataAcquisitionError('TEARDOWN_FAILED'))
          else resolve()
        })
      })
      destroyState = { bounded, completed: completion.promise }
      try {
        // Calling destroy is synchronous even though cleanup finishes via
        // the callback. WebTorrent checks `destroyed` immediately after its
        // metadata event, so this prevents verification or payload I/O.
        torrent.destroy({ destroyStore: true }, error => {
          completion.resolve(error)
        })
      } catch {
        if (timer) clearTimeout(timer)
        rejectDestroy()
      }
      return destroyState
    }

    let bytes: Uint8Array | null = null
    let acquisitionError: unknown = null
    try {
      bytes = await new Promise<Uint8Array>((resolve, reject) => {
        const admittedPeers = new Set<unknown>()
        let settled = false
        const finish = (
          error: MetadataAcquisitionError | null,
          value?: Uint8Array
        ): void => {
          if (settled) return
          settled = true
          discovery?.freeze()
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (error || !value) {
            reject(error ?? new MetadataAcquisitionError('TORRENT_ERROR'))
            return
          }
          resolve(value)
        }
        const onAbort = (): void => {
          finish(new MetadataAcquisitionError('ABORTED'))
        }
        const finishAfterDestroy = (
          error: MetadataAcquisitionError | null,
          value?: Uint8Array
        ): void => {
          void destroyTorrent().bounded.then(
            () => finish(error, value),
            () => finish(new MetadataAcquisitionError('TEARDOWN_FAILED'))
          )
        }
        const timer = setTimeout(
          () => finish(new MetadataAcquisitionError('TIMED_OUT')),
          this.#options.timeoutMs ?? METADATA_ACQUISITION_LIMITS.timeoutMs
        )
        timer.unref?.()
        signal?.addEventListener('abort', onAbort, { once: true })

        torrent.on('error', () => {
          finish(new MetadataAcquisitionError('TORRENT_ERROR'))
        })
        // The info dictionary is taken and bound inside this handler, before
        // WebTorrent can verify or store a single piece.
        torrent.on('metadata', () => {
          // Close admission synchronously, before copying or validating bytes
          // and before WebTorrent can continue past this metadata event.
          discovery?.freeze()
          const file = torrent.torrentFile
          if (!file || file.byteLength === 0) {
            finishAfterDestroy(new MetadataAcquisitionError('TORRENT_ERROR'))
            return
          }
          let identity
          try {
            identity = canonicalInfoIdentity(file.slice())
          } catch (error) {
            finishAfterDestroy(
              new MetadataAcquisitionError(
                error instanceof TorrentInputError
                  ? 'BINDING_MISMATCH'
                  : 'TORRENT_ERROR'
              )
            )
            return
          }
          // Staged metadata whose canonical info hash differs from the
          // reservation never leaves this method.
          if (identity.infoHash !== prepared.infoHash) {
            finishAfterDestroy(new MetadataAcquisitionError('BINDING_MISMATCH'))
            return
          }
          const bytes = file.slice()
          // Destruction starts inside the synchronous metadata handler, before
          // WebTorrent can continue into verification or its ready callback.
          finishAfterDestroy(null, bytes)
        })

        try {
          discovery = this.#options.discover({
            admitPeer: peer => {
              try {
                const admitted = addPeerTracked(torrent, peer, 'tracker')
                if (admitted) admittedPeers.add(peer)
                return admitted
              } catch {
                return false
              }
            },
            allowDht: prepared.dhtEnabled,
            infoHash: prepared.infoHash,
            peerId: lease.peerId,
            port: lease.port,
            removePeer: peer => {
              torrent.removePeer?.(peer)
              admittedPeers.delete(peer)
            },
            retirePeers: () => {
              for (const peer of admittedPeers) {
                try {
                  torrent.removePeer?.(peer)
                } catch {
                  // Retirement continues through a peer already removed.
                }
              }
              admittedPeers.clear()
            },
            trackers: prepared.trackers
          })
          if (settled) discovery.freeze()
          void discovery.ready.catch(() => {
            finish(new MetadataAcquisitionError('DISCOVERY_FAILED'))
          })
        } catch {
          finish(new MetadataAcquisitionError('DISCOVERY_FAILED'))
        }
      })
    } catch (error) {
      acquisitionError = error
    }

    // Discovery stops before the staging torrent, and the torrent is
    // destroyed with its store either way.
    const currentDiscovery = discovery as MetadataDiscoveryControl | null
    if (currentDiscovery) {
      try {
        currentDiscovery.freeze()
        await currentDiscovery.stop()
      } catch {
        // Teardown continues through a failing discovery source.
      }
    }
    const teardown = destroyTorrent()
    try {
      await teardown.bounded
    } catch (error) {
      this.#markUnhealthy(error)
      deferSlotRelease(
        teardown.completed.then(async callbackError => {
          if (callbackError) throw callbackError
          await lease.release()
        })
      )
      throw new MetadataAcquisitionError('TEARDOWN_FAILED')
    }
    // The staging client goes last, after its own torrent is gone.
    try {
      await lease.release()
    } catch (error) {
      this.#markUnhealthy(error)
      // The staging pool retains its own slot until the callback. This
      // acquisition slot remains held as well because completion is unknown.
      deferSlotRelease(new Promise(() => undefined))
      throw new MetadataAcquisitionError('TEARDOWN_FAILED')
    }

    if (acquisitionError) throw acquisitionError
    if (!bytes) throw new MetadataAcquisitionError('TORRENT_ERROR')
    return bytes
  }

  #markUnhealthy(error: unknown): void {
    if (this.#unhealthy) return
    this.#unhealthy = true
    this.#options.onUnhealthy?.(
      error instanceof Error ? error : new Error('STAGING_TEARDOWN_FAILED')
    )
  }
}
