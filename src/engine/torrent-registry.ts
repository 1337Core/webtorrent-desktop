import { randomUUID } from 'node:crypto'

export const TORRENT_REGISTRY_LIMITS = Object.freeze({
  aggregateFileEntries: 250_000,
  loadedTorrents: 64
})

export type TorrentOwner = 'private' | 'public' | 'staging'

type TorrentRegistryState = 'committed' | 'reserved' | 'tombstoned'

export type TorrentRegistryErrorCode =
  | 'CAPACITY_EXCEEDED'
  | 'DUPLICATE_INFO_HASH'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'

export class TorrentRegistryError extends Error {
  readonly code: TorrentRegistryErrorCode

  constructor(code: TorrentRegistryErrorCode) {
    super(`Torrent registry operation failed: ${code}.`)
    this.name = 'TorrentRegistryError'
    this.code = code
  }
}

export type TorrentReservation = Readonly<{
  fileCount: number
  generationId: string
  infoHash: string
  owner: TorrentOwner
  token: symbol
}>

export type TorrentRegistryEntry = Readonly<{
  admits: boolean
  fileCount: number
  generationId: string
  infoHash: string
  owner: TorrentOwner
  state: TorrentRegistryState
}>

export type TorrentRegistryOptions = Readonly<{
  createGenerationId?: () => string
}>

type RegistryRecord = {
  fileCount: number
  generationId: string
  infoHash: string
  owner: TorrentOwner
  state: TorrentRegistryState
  token: symbol
}

const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/u
const OWNERS = new Set<TorrentOwner>(['private', 'public', 'staging'])

function assertInfoHash(infoHash: string): void {
  if (typeof infoHash !== 'string' || !INFO_HASH_PATTERN.test(infoHash)) {
    throw new TorrentRegistryError('INVALID_INPUT')
  }
}

function snapshot(record: RegistryRecord): TorrentRegistryEntry {
  return {
    admits: record.state === 'committed',
    fileCount: record.fileCount,
    generationId: record.generationId,
    infoHash: record.infoHash,
    owner: record.owner,
    state: record.state
  }
}

/**
 * The single authority for which info hashes this engine owns, across the
 * public, private, and staging clients.
 *
 * WebTorrent's own duplicate check and add callback are not lifecycle
 * authority: `client.get()` resolves asynchronously and an add can race a
 * removal. Every add therefore reserves its info hash here first, and the
 * reservation survives until either an explicit rollback or the completed
 * destroy callback releases it.
 */
export class TorrentRegistry {
  readonly #createGenerationId: () => string
  readonly #records = new Map<string, RegistryRecord>()
  #fileEntryCount = 0

  constructor(options: TorrentRegistryOptions = {}) {
    this.#createGenerationId = options.createGenerationId ?? randomUUID
  }

  get size(): number {
    return this.#records.size
  }

  get fileEntryCount(): number {
    return this.#fileEntryCount
  }

  /**
   * Reserves an info hash before WebTorrent's asynchronous add path runs. A
   * reserved-but-uncommitted generation admits no peer.
   */
  reserve(
    input: Readonly<{
      fileCount: number
      infoHash: string
      owner: TorrentOwner
    }>
  ): TorrentReservation {
    assertInfoHash(input.infoHash)
    if (
      !OWNERS.has(input.owner) ||
      !Number.isSafeInteger(input.fileCount) ||
      input.fileCount < 0
    ) {
      throw new TorrentRegistryError('INVALID_INPUT')
    }
    if (this.#records.has(input.infoHash)) {
      throw new TorrentRegistryError('DUPLICATE_INFO_HASH')
    }
    if (
      this.#records.size >= TORRENT_REGISTRY_LIMITS.loadedTorrents ||
      this.#fileEntryCount + input.fileCount >
        TORRENT_REGISTRY_LIMITS.aggregateFileEntries
    ) {
      throw new TorrentRegistryError('CAPACITY_EXCEEDED')
    }

    const record: RegistryRecord = {
      fileCount: input.fileCount,
      generationId: this.#createGenerationId(),
      infoHash: input.infoHash,
      owner: input.owner,
      state: 'reserved',
      token: Symbol(input.infoHash)
    }
    this.#records.set(record.infoHash, record)
    this.#fileEntryCount += record.fileCount
    return {
      fileCount: record.fileCount,
      generationId: record.generationId,
      infoHash: record.infoHash,
      owner: record.owner,
      token: record.token
    }
  }

  /**
   * Called from the synchronous metadata commit barrier once identity, store
   * grant, selection, and network manifest all match the reservation.
   */
  commit(reservation: TorrentReservation): TorrentRegistryEntry {
    const record = this.#require(reservation.infoHash)
    if (record.token !== reservation.token) {
      throw new TorrentRegistryError('STATE_CONFLICT')
    }
    if (record.state !== 'reserved') {
      throw new TorrentRegistryError('STATE_CONFLICT')
    }
    record.state = 'committed'
    return snapshot(record)
  }

  /** Pre-metadata failure releases the reservation without a tombstone. */
  rollback(reservation: TorrentReservation): void {
    const record = this.#require(reservation.infoHash)
    if (record.token !== reservation.token || record.state !== 'reserved') {
      throw new TorrentRegistryError('STATE_CONFLICT')
    }
    this.#remove(record)
  }

  /**
   * Marks a committed torrent as tearing down. WebTorrent emits `close` before
   * cleanup finishes, so the hash stays unavailable until `release`.
   */
  beginTeardown(infoHash: string): TorrentRegistryEntry {
    assertInfoHash(infoHash)
    const record = this.#require(infoHash)
    if (record.state === 'reserved') {
      throw new TorrentRegistryError('STATE_CONFLICT')
    }
    record.state = 'tombstoned'
    return snapshot(record)
  }

  /** Idempotent: the destroy callback may arrive once, late, or never twice. */
  release(infoHash: string): boolean {
    assertInfoHash(infoHash)
    const record = this.#records.get(infoHash)
    if (!record) return false
    if (record.state !== 'tombstoned') {
      throw new TorrentRegistryError('STATE_CONFLICT')
    }
    this.#remove(record)
    return true
  }

  /** True only for a committed generation; every other state stays closed. */
  admits(infoHash: string, generationId?: string): boolean {
    if (typeof infoHash !== 'string' || !INFO_HASH_PATTERN.test(infoHash)) {
      return false
    }
    const record = this.#records.get(infoHash)
    if (!record || record.state !== 'committed') return false
    return generationId === undefined || record.generationId === generationId
  }

  has(infoHash: string): boolean {
    return (
      typeof infoHash === 'string' &&
      INFO_HASH_PATTERN.test(infoHash) &&
      this.#records.has(infoHash)
    )
  }

  get(infoHash: string): TorrentRegistryEntry | null {
    if (typeof infoHash !== 'string' || !INFO_HASH_PATTERN.test(infoHash)) {
      return null
    }
    const record = this.#records.get(infoHash)
    return record ? snapshot(record) : null
  }

  list(): ReadonlyArray<TorrentRegistryEntry> {
    return [...this.#records.values()].map(snapshot)
  }

  listByOwner(owner: TorrentOwner): ReadonlyArray<TorrentRegistryEntry> {
    return this.list().filter(entry => entry.owner === owner)
  }

  /**
   * Engine shutdown tombstones everything still present so no late callback
   * can resurrect a generation while clients are being destroyed.
   */
  closeAll(): ReadonlyArray<TorrentRegistryEntry> {
    const closed: TorrentRegistryEntry[] = []
    for (const record of this.#records.values()) {
      record.state = 'tombstoned'
      closed.push(snapshot(record))
    }
    return closed
  }

  #require(infoHash: string): RegistryRecord {
    const record = this.#records.get(infoHash)
    if (!record) throw new TorrentRegistryError('NOT_FOUND')
    return record
  }

  #remove(record: RegistryRecord): void {
    this.#records.delete(record.infoHash)
    this.#fileEntryCount -= record.fileCount
    if (this.#fileEntryCount < 0) this.#fileEntryCount = 0
  }
}
