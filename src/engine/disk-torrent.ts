import type { TorrentOptions } from 'webtorrent'
import { GuardedStoreSupervisor, type GuardedStoreGrant } from './guarded-store'
import {
  runMetadataCommitBarrier,
  type CommitBarrierResult
} from './metadata-commit-barrier'
import { desiredPieceRanges, type PieceRange } from './piece-selection'
import type { ValidatedTorrentMetadata } from './torrent-metadata'
import {
  TorrentRegistry,
  type TorrentOwner,
  type TorrentReservation
} from './torrent-registry'

export const DISK_TORRENT_TIMEOUTS = Object.freeze({
  destroyMs: 4_000,
  readyMs: 300_000
})

export type DiskTorrentErrorCode =
  | 'ADD_FAILED'
  | 'COMMIT_REJECTED'
  | 'DESTROYED'
  | 'READY_TIMEOUT'
  | 'STATE_CONFLICT'
  | 'TORRENT_ERROR'

export class DiskTorrentError extends Error {
  readonly code: DiskTorrentErrorCode
  readonly detail: string

  constructor(code: DiskTorrentErrorCode, detail = '') {
    super(`Disk torrent operation failed: ${code}.`)
    this.name = 'DiskTorrentError'
    this.code = code
    this.detail = detail
  }
}

/** The exact WebTorrent torrent surface the disk-backed session consumes. */
export type EngineTorrent = {
  addPeer(peer: string, source?: string): boolean
  deselect(start: number, end: number): void
  destroy(
    options: { destroyStore: boolean },
    callback: (error?: Error) => void
  ): void
  destroyed: boolean
  done: boolean
  downloadSpeed: number
  downloaded: number
  files: ReadonlyArray<{ downloaded: number; length: number; path: string }>
  infoHash: string
  length: number
  name: string
  numPeers: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
  pause(): void
  pieceLength: number
  private: boolean
  progress: number
  ready: boolean
  resume(): void
  select(start: number, end: number, priority?: number): void
  timeRemaining: number
  torrentFile: Uint8Array
  uploadSpeed: number
  uploaded: number
}

/** Live counters the engine reports to the renderer as bounded DTOs. */
export type DiskTorrentStats = Readonly<{
  done: boolean
  downloadSpeed: number
  downloaded: number
  fileDownloaded: ReadonlyArray<number>
  numPeers: number
  progress: number
  timeRemainingMs: number | null
  uploadSpeed: number
  uploaded: number
}>

export type EngineAddClient = {
  add(torrentId: Uint8Array, options: TorrentOptions): EngineTorrent
}

/**
 * One tracker activation for a torrent generation. Pause destroys it and
 * resume creates a fresh one, so no announce can cross a generation.
 */
export type TorrentActivation = Readonly<{
  start: () => void
  stop: () => Promise<void>
}>

export type DiskTorrentAddInput = Readonly<{
  client: EngineAddClient
  downloadRoot: string
  metadata: ValidatedTorrentMetadata
  owner: TorrentOwner
  selectedIndexes: ReadonlyArray<number>
  startPaused?: boolean
}>

export type DiskTorrentSessionOptions = Readonly<{
  createActivation?: (session: DiskTorrentSession) => TorrentActivation | null
  destroyTimeoutMs?: number
  onCommitFailure?: (infoHash: string, result: CommitBarrierResult) => void
  /** Runs again immediately before every handoff, whatever discovered it. */
  peerFilter?: (address: string) => boolean
  readyTimeoutMs?: number
  registry: TorrentRegistry
}>

export type DiskTorrentState =
  'adding' | 'paused' | 'removed' | 'removing' | 'running'

export type DiskTorrentSnapshot = Readonly<{
  generationId: string
  infoHash: string
  name: string
  owner: TorrentOwner
  selectedIndexes: ReadonlyArray<number>
  state: DiskTorrentState
}>

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(Math.max(value, minimum), maximum)
}

function clampRate(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : 0
}

/**
 * A disk-backed torrent for one registry generation.
 *
 * The add is always paused and fully deselected: nothing is selected, no
 * tracker adapter exists, and no peer is admitted until the synchronous
 * metadata barrier commits the reservation.
 */
export class DiskTorrentSession {
  readonly #createActivation: (
    session: DiskTorrentSession
  ) => TorrentActivation | null
  readonly #destroyTimeoutMs: number
  readonly #metadata: ValidatedTorrentMetadata
  readonly #owner: TorrentOwner
  readonly #peerFilter: (address: string) => boolean
  readonly #registry: TorrentRegistry
  readonly #reservation: TorrentReservation
  readonly #storeSupervisor: GuardedStoreSupervisor
  #activation: TorrentActivation | null = null
  #committed = false
  #selectedIndexes: number[]
  #state: DiskTorrentState = 'adding'
  #torrent: EngineTorrent | null = null

  private constructor(
    metadata: ValidatedTorrentMetadata,
    owner: TorrentOwner,
    registry: TorrentRegistry,
    reservation: TorrentReservation,
    storeSupervisor: GuardedStoreSupervisor,
    selectedIndexes: ReadonlyArray<number>,
    options: DiskTorrentSessionOptions
  ) {
    this.#createActivation = options.createActivation ?? (() => null)
    this.#destroyTimeoutMs =
      options.destroyTimeoutMs ?? DISK_TORRENT_TIMEOUTS.destroyMs
    this.#metadata = metadata
    this.#owner = owner
    this.#peerFilter = options.peerFilter ?? (() => true)
    this.#registry = registry
    this.#reservation = reservation
    this.#selectedIndexes = [...selectedIndexes]
    this.#storeSupervisor = storeSupervisor
  }

  static grantFor(
    metadata: ValidatedTorrentMetadata,
    downloadRoot: string
  ): GuardedStoreGrant {
    return {
      chunkLength: metadata.pieceLength,
      files: metadata.files,
      root: downloadRoot,
      totalLength: metadata.length
    }
  }

  /**
   * Reserves the info hash, builds the guarded store, and adds the torrent
   * with the exact qualified options. Resolves once the torrent is ready and
   * its reservation is committed.
   */
  static async add(
    input: DiskTorrentAddInput,
    options: DiskTorrentSessionOptions
  ): Promise<DiskTorrentSession> {
    const reservation = options.registry.reserve({
      fileCount: input.metadata.files.length,
      infoHash: input.metadata.infoHash,
      owner: input.owner
    })

    let storeSupervisor: GuardedStoreSupervisor
    try {
      storeSupervisor = new GuardedStoreSupervisor(
        DiskTorrentSession.grantFor(input.metadata, input.downloadRoot)
      )
    } catch (error) {
      options.registry.rollback(reservation)
      throw new DiskTorrentError(
        'ADD_FAILED',
        error instanceof Error ? error.name : 'unknown'
      )
    }

    const session = new DiskTorrentSession(
      input.metadata,
      input.owner,
      options.registry,
      reservation,
      storeSupervisor,
      input.selectedIndexes,
      options
    )

    try {
      await session.#run(input, options)
    } catch (error) {
      throw error instanceof DiskTorrentError
        ? error
        : new DiskTorrentError('ADD_FAILED')
    }
    return session
  }

  get infoHash(): string {
    return this.#metadata.infoHash
  }

  get metadata(): ValidatedTorrentMetadata {
    return this.#metadata
  }

  get owner(): TorrentOwner {
    return this.#owner
  }

  get generationId(): string {
    return this.#reservation.generationId
  }

  get state(): DiskTorrentState {
    return this.#state
  }

  get selectedIndexes(): ReadonlyArray<number> {
    return [...this.#selectedIndexes]
  }

  /**
   * Bounded live counters. Values are clamped rather than trusted so a
   * WebTorrent regression cannot produce a DTO the contract rejects.
   */
  stats(): DiskTorrentStats {
    const torrent = this.#torrent
    const length = this.#metadata.length
    const downloaded = Math.trunc(clamp(torrent?.downloaded ?? 0, 0, length))
    const timeRemaining = torrent?.timeRemaining ?? Number.NaN
    return {
      done: torrent?.done ?? false,
      downloadSpeed: clampRate(torrent?.downloadSpeed),
      downloaded,
      fileDownloaded: this.#metadata.files.map((file, index) =>
        Math.trunc(
          clamp(torrent?.files[index]?.downloaded ?? 0, 0, file.length)
        )
      ),
      numPeers: Math.min(
        Math.max(Math.trunc(torrent?.numPeers ?? 0), 0),
        10_000
      ),
      progress: length === 0 ? 1 : clamp(downloaded / length, 0, 1),
      timeRemainingMs:
        Number.isFinite(timeRemaining) && timeRemaining >= 0
          ? Math.min(Math.trunc(timeRemaining), Number.MAX_SAFE_INTEGER)
          : null,
      uploadSpeed: clampRate(torrent?.uploadSpeed),
      uploaded: Math.max(Math.trunc(torrent?.uploaded ?? 0), 0)
    }
  }

  snapshot(): DiskTorrentSnapshot {
    return {
      generationId: this.#reservation.generationId,
      infoHash: this.#metadata.infoHash,
      name: this.#metadata.name,
      owner: this.#owner,
      selectedIndexes: [...this.#selectedIndexes],
      state: this.#state
    }
  }

  /**
   * The last gate before WebTorrent sees a discovered peer. A closed, paused,
   * or superseded generation admits nothing, and the address policy runs again
   * here rather than trusting whichever transport produced the candidate.
   */
  admitPeer(address: string, source = 'tracker'): boolean {
    const torrent = this.#torrent
    if (!torrent || this.#state !== 'running') return false
    if (
      !this.#registry.admits(
        this.#metadata.infoHash,
        this.#reservation.generationId
      )
    ) {
      return false
    }
    if (!this.#peerFilter(address)) return false
    try {
      return torrent.addPeer(address, source)
    } catch {
      return false
    }
  }

  /** Rebuilds and reapplies the complete desired selection. */
  updateSelection(selectedIndexes: ReadonlyArray<number>): void {
    if (this.#state === 'removed' || this.#state === 'removing') {
      throw new DiskTorrentError('STATE_CONFLICT')
    }
    this.#selectedIndexes = [...new Set(selectedIndexes)].sort(
      (left, right) => left - right
    )
    if (this.#state === 'running') this.#applySelection()
  }

  /**
   * Closes admission, stops tracker work, clears the whole selection, and
   * pauses the torrent. No continuing transfer is claimed afterwards.
   */
  async pause(): Promise<void> {
    if (this.#state === 'paused') return
    if (this.#state !== 'running') {
      throw new DiskTorrentError('STATE_CONFLICT')
    }
    this.#state = 'paused'
    await this.#stopActivation()
    this.#clearSelection()
    this.#torrent?.pause()
  }

  /** Recreates discovery from scratch; a stale generation never resumes. */
  resume(): void {
    if (this.#state === 'running') return
    if (this.#state !== 'paused') {
      throw new DiskTorrentError('STATE_CONFLICT')
    }
    this.#state = 'running'
    this.#applySelection()
    this.#torrent?.resume()
    this.#startActivation()
  }

  /**
   * Destroys exactly once with the store preserved, and keeps the registry
   * tombstone until the destroy callback actually completes.
   */
  async remove(): Promise<void> {
    if (this.#state === 'removed') return
    if (this.#state === 'removing') {
      throw new DiskTorrentError('STATE_CONFLICT')
    }
    this.#state = 'removing'
    if (this.#committed) this.#registry.beginTeardown(this.#metadata.infoHash)
    await this.#stopActivation()
    this.#clearSelection()

    const torrent = this.#torrent
    this.#torrent = null
    if (torrent) await this.#destroyTorrent(torrent)
    await this.#storeSupervisor.close()

    if (this.#committed) this.#registry.release(this.#metadata.infoHash)
    this.#state = 'removed'
  }

  async #run(
    input: DiskTorrentAddInput,
    options: DiskTorrentSessionOptions
  ): Promise<void> {
    const readyTimeoutMs =
      options.readyTimeoutMs ?? DISK_TORRENT_TIMEOUTS.readyMs

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        fail(new DiskTorrentError('READY_TIMEOUT'))
      }, readyTimeoutMs)
      timer.unref()

      const fail = (error: DiskTorrentError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const torrent = this.#torrent
        this.#torrent = null
        if (torrent && !torrent.destroyed) {
          torrent.destroy({ destroyStore: false }, () => undefined)
        }
        if (!this.#committed) this.#registry.rollback(this.#reservation)
        this.#state = 'removed'
        reject(error)
      }

      let torrent: EngineTorrent
      try {
        torrent = input.client.add(
          this.#metadata.torrentBytes,
          this.#addOptions(input.downloadRoot)
        )
      } catch {
        settled = true
        clearTimeout(timer)
        this.#registry.rollback(this.#reservation)
        this.#state = 'removed'
        reject(new DiskTorrentError('ADD_FAILED'))
        return
      }
      this.#torrent = torrent

      torrent.on('error', () => {
        fail(new DiskTorrentError('TORRENT_ERROR'))
      })
      torrent.on('close', () => {
        fail(new DiskTorrentError('DESTROYED'))
      })

      // The commit barrier must complete inside this synchronous handler so a
      // mismatch is destroyed before WebTorrent can verify a single piece.
      torrent.on('metadata', () => {
        if (settled) return
        const result = runMetadataCommitBarrier({
          expected: this.#metadata,
          observed: {
            files: torrent.files.map(file => ({
              length: file.length,
              path: file.path
            })),
            infoHash: torrent.infoHash,
            length: torrent.length,
            name: torrent.name,
            pieceLength: torrent.pieceLength,
            private: torrent.private,
            torrentFile: torrent.torrentFile
          },
          reservation: this.#reservation,
          storeFaults: this.#storeSupervisor.faults
        })
        if (!result.ok) {
          options.onCommitFailure?.(this.#metadata.infoHash, result)
          fail(new DiskTorrentError('COMMIT_REJECTED', result.code))
          return
        }
        this.#registry.commit(this.#reservation)
        this.#committed = true
      })

      torrent.on('ready', () => {
        if (settled) return
        if (!this.#committed) {
          fail(new DiskTorrentError('COMMIT_REJECTED', 'missing barrier'))
          return
        }
        settled = true
        clearTimeout(timer)
        resolve()
      })
    })

    await this.#storeSupervisor.materializeSelected(this.#selectedIndexes)
    this.#state = 'paused'
    if (input.startPaused === false) this.resume()
  }

  #addOptions(downloadRoot: string): TorrentOptions {
    return {
      addUID: false,
      deselect: true,
      destroyStoreOnDestroy: false,
      path: downloadRoot,
      paused: true,
      private: this.#metadata.private,
      skipVerify: false,
      store: this.#storeSupervisor.storeConstructor(),
      storeCacheSlots: 0,
      storeOpts: { ...this.#storeSupervisor.storeOptions }
    }
  }

  #ranges(): ReadonlyArray<PieceRange> {
    return desiredPieceRanges(this.#metadata.files, this.#selectedIndexes, {
      pieceCount: this.#metadata.pieceCount,
      pieceLength: this.#metadata.pieceLength,
      totalLength: this.#metadata.length
    })
  }

  #applySelection(): void {
    const torrent = this.#torrent
    if (!torrent || this.#metadata.pieceCount === 0) return
    torrent.deselect(0, this.#metadata.pieceCount - 1)
    for (const range of this.#ranges()) {
      torrent.select(range.start, range.end, 1)
    }
  }

  #clearSelection(): void {
    const torrent = this.#torrent
    if (!torrent || this.#metadata.pieceCount === 0) return
    torrent.deselect(0, this.#metadata.pieceCount - 1)
  }

  #startActivation(): void {
    this.#activation = this.#createActivation(this)
    this.#activation?.start()
  }

  async #stopActivation(): Promise<void> {
    const activation = this.#activation
    this.#activation = null
    if (!activation) return
    try {
      await activation.stop()
    } catch {
      // Tracker teardown failures never block the lifecycle command.
    }
  }

  #destroyTorrent(torrent: EngineTorrent): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, this.#destroyTimeoutMs)
      timer.unref()

      try {
        // Never await client.remove(): `close` is emitted before cleanup
        // finishes and a second destroy may never invoke its callback.
        torrent.destroy({ destroyStore: false }, () => finish())
      } catch {
        finish()
      }
    })
  }
}
