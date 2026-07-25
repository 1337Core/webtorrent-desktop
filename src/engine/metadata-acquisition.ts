import { canonicalInfoIdentity, TorrentInputError } from './torrent-metadata'
import type { PreparedMagnet } from './torrent-metadata'

export const METADATA_ACQUISITION_LIMITS = Object.freeze({
  /** Acquisitions running at once, engine-wide. */
  maxConcurrent: 2,
  /** One acquisition's whole budget, from add to metadata. */
  timeoutMs: 120_000
} as const)

type MetadataAcquisitionErrorCode =
  | 'ABORTED'
  | 'BINDING_MISMATCH'
  | 'CAPACITY_EXCEEDED'
  | 'CLOSED'
  | 'DISCOVERY_FAILED'
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
  addPeer(peer: string, source?: string): boolean
  destroy(
    options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  readonly torrentFile?: Uint8Array
}

export type AcquisitionClient = {
  add(uri: string, options: Record<string, unknown>): AcquisitionTorrent
}

/**
 * Starts app-owned discovery for one acquisition and resolves to its stop
 * function. Trackers and, only with consent, the DHT are reached through the
 * same mediated boundaries an owned torrent uses; nothing here talks to the
 * network itself.
 */
type MetadataDiscovery = (
  input: Readonly<{
    admitPeer: (address: string) => boolean
    allowDht: boolean
    infoHash: string
    trackers: ReadonlyArray<string>
  }>
) => Promise<() => Promise<void>>

export type MetadataAcquisitionOptions = Readonly<{
  createClient: () => AcquisitionClient
  discover: MetadataDiscovery
  /** The staging directory a torrent is destroyed out of before it is used. */
  stagingPath: string
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
  #active = 0
  #closed = false

  constructor(options: MetadataAcquisitionOptions) {
    this.#options = options
  }

  get activeCount(): number {
    return this.#active
  }

  close(): void {
    this.#closed = true
  }

  async acquire(
    prepared: PreparedMagnet,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (this.#closed) throw new MetadataAcquisitionError('CLOSED')
    if (this.#active >= METADATA_ACQUISITION_LIMITS.maxConcurrent) {
      throw new MetadataAcquisitionError('CAPACITY_EXCEEDED')
    }
    if (signal?.aborted) throw new MetadataAcquisitionError('ABORTED')

    this.#active += 1
    try {
      return await this.#run(prepared, signal)
    } finally {
      this.#active -= 1
    }
  }

  async #run(
    prepared: PreparedMagnet,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const torrent = this.#options.createClient().add(prepared.magnetUri, {
      announce: [],
      path: this.#options.stagingPath
    })

    let stopDiscovery: (() => Promise<void>) | null = null
    try {
      const bytes = await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false
        const finish = (
          error: MetadataAcquisitionError | null,
          value?: Uint8Array
        ): void => {
          if (settled) return
          settled = true
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
          const file = torrent.torrentFile
          if (!file || file.byteLength === 0) {
            finish(new MetadataAcquisitionError('TORRENT_ERROR'))
            return
          }
          let identity
          try {
            identity = canonicalInfoIdentity(file.slice())
          } catch (error) {
            finish(
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
            finish(new MetadataAcquisitionError('BINDING_MISMATCH'))
            return
          }
          finish(null, file.slice())
        })

        this.#options
          .discover({
            admitPeer: address => {
              try {
                return torrent.addPeer(address, 'tracker')
              } catch {
                return false
              }
            },
            allowDht: prepared.dhtEnabled,
            infoHash: prepared.infoHash,
            trackers: prepared.trackers
          })
          .then(stop => {
            stopDiscovery = stop
            if (settled) void stop().catch(() => undefined)
          })
          .catch(() => {
            finish(new MetadataAcquisitionError('DISCOVERY_FAILED'))
          })
      })
      return bytes
    } finally {
      // Discovery stops before the staging torrent, and the torrent is
      // destroyed with its store either way.
      const stop = stopDiscovery as (() => Promise<void>) | null
      if (stop) {
        try {
          await stop()
        } catch {
          // Teardown continues through a failing discovery source.
        }
      }
      await new Promise<void>(resolve => {
        try {
          torrent.destroy({ destroyStore: true }, () => resolve())
        } catch {
          resolve()
        }
      })
    }
  }
}
