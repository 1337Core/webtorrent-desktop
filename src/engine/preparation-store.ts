import { randomUUID } from 'node:crypto'
import type { ValidatedTorrentMetadata } from './torrent-metadata'

export const PREPARATION_LIMITS = Object.freeze({
  filePagePathBytes: 40_960,
  filePageSize: 64,
  preparations: 4,
  retainedTorrentBytes: 20_000_000,
  selectionChanges: 250,
  ttlMs: 15 * 60_000
})

export type PreparationWarning =
  | 'DHT_EXPOSURE_USED'
  | 'TRACKER_TRANSPORT_DISABLED'
  | 'WEB_SEED_DISABLED'
  | 'WEB_SEED_INVALID'
  | 'XS_REMOVED'

export type PreparationSourcePolicy =
  | Readonly<{
      kind: 'local-torrent'
    }>
  | Readonly<{
      allowHttp: boolean
      allowPrivateNetwork: boolean
      kind: 'remote-torrent'
    }>
  | Readonly<{
      allowDhtExposure: boolean
      allowPrivateNetwork: boolean
      kind: 'magnet' | 'info-hash'
    }>

export type PreparationLifecycleState = 'committing' | 'open'

export type PreparationSnapshot = Readonly<{
  expiresAtMs: number
  fileCount: number
  infoHash: string
  length: number
  lifecycleState: PreparationLifecycleState
  name: string
  preparationId: string
  private: boolean
  selectedFileCount: number
  sourcePolicy: PreparationSourcePolicy
  warnings: ReadonlyArray<PreparationWarning>
}>

export type PreparationFilePage = Readonly<{
  items: ReadonlyArray<
    Readonly<{
      downloaded: 0
      index: number
      length: number
      path: string
      progress: 0
      selected: boolean
    }>
  >
  nextCursor: number | null
  preparationId: string
  total: number
}>

export type PreparationCommitReservation = Readonly<{
  expiresAtMs: number
  metadata: ValidatedTorrentMetadata
  preparationId: string
  reservationToken: symbol
  selectedIndexes: ReadonlyArray<number>
  sourcePolicy: PreparationSourcePolicy
  warnings: ReadonlyArray<PreparationWarning>
}>

export type PreparationStoreErrorCode =
  | 'CAPACITY_EXCEEDED'
  | 'DUPLICATE_INFO_HASH'
  | 'EXPIRED'
  | 'INVALID_PAGE'
  | 'INVALID_SELECTION'
  | 'INVALID_WARNING'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'

export class PreparationStoreError extends Error {
  readonly code: PreparationStoreErrorCode

  constructor(code: PreparationStoreErrorCode) {
    super(`Torrent preparation operation failed: ${code}.`)
    this.name = 'PreparationStoreError'
    this.code = code
  }
}

type PreparationRecord = {
  commitToken: symbol | null
  expiresAtMs: number
  metadata: ValidatedTorrentMetadata | null
  preparationId: string
  selectedIndexes: Set<number>
  sourcePolicy: PreparationSourcePolicy
  state: PreparationLifecycleState
  warnings: PreparationWarning[]
}

export type PreparationStoreOptions = Readonly<{
  createId?: () => string
  now?: () => number
}>

export type CreatePreparationInput = Readonly<{
  metadata: ValidatedTorrentMetadata
  sourcePolicy: PreparationSourcePolicy
  warnings?: ReadonlyArray<PreparationWarning>
}>

export type SelectionChange = Readonly<{
  index: number
  selected: boolean
}>

const utf8Encoder = new TextEncoder()
const uuidV4Pattern =
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu
const validWarnings = new Set<PreparationWarning>([
  'DHT_EXPOSURE_USED',
  'TRACKER_TRANSPORT_DISABLED',
  'WEB_SEED_DISABLED',
  'WEB_SEED_INVALID',
  'XS_REMOVED'
])

function cloneSourcePolicy(
  policy: PreparationSourcePolicy
): PreparationSourcePolicy {
  return { ...policy }
}

function cloneMetadata(
  metadata: ValidatedTorrentMetadata
): ValidatedTorrentMetadata {
  return {
    announceTiers: metadata.announceTiers.map(tier => [...tier]),
    files: metadata.files
      .map(file => ({ ...file }))
      .sort((left, right) => left.index - right.index),
    infoHash: metadata.infoHash,
    length: metadata.length,
    name: metadata.name,
    pieceCount: metadata.pieceCount,
    pieceLength: metadata.pieceLength,
    private: metadata.private,
    torrentBytes: metadata.torrentBytes.slice(),
    warnings: [...metadata.warnings],
    webSeeds: [...metadata.webSeeds]
  }
}

function combinedWarnings(
  metadata: ValidatedTorrentMetadata,
  additional: ReadonlyArray<PreparationWarning>
): PreparationWarning[] {
  const warnings: PreparationWarning[] = []
  for (const warning of [...metadata.warnings, ...additional]) {
    if (!validWarnings.has(warning)) {
      throw new PreparationStoreError('INVALID_WARNING')
    }
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  if (warnings.length > validWarnings.size) {
    throw new PreparationStoreError('INVALID_WARNING')
  }
  return warnings
}

export class PreparationStore {
  readonly #createId: () => string
  readonly #now: () => number
  readonly #recordsById = new Map<string, PreparationRecord>()
  readonly #preparationIdByInfoHash = new Map<string, string>()
  #retainedTorrentBytes = 0

  constructor(options: PreparationStoreOptions = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#now = options.now ?? Date.now
  }

  create(input: CreatePreparationInput): PreparationSnapshot {
    this.expire()

    if (this.#preparationIdByInfoHash.has(input.metadata.infoHash)) {
      throw new PreparationStoreError('DUPLICATE_INFO_HASH')
    }
    if (
      this.#recordsById.size >= PREPARATION_LIMITS.preparations ||
      input.metadata.torrentBytes.byteLength === 0 ||
      this.#retainedTorrentBytes + input.metadata.torrentBytes.byteLength >
        PREPARATION_LIMITS.retainedTorrentBytes
    ) {
      throw new PreparationStoreError('CAPACITY_EXCEEDED')
    }

    const now = this.#currentTime()
    if (!Number.isSafeInteger(now + PREPARATION_LIMITS.ttlMs)) {
      throw new Error('Preparation expiry exceeds the safe integer range')
    }
    const preparationId = this.#newPreparationId()
    const metadata = cloneMetadata(input.metadata)
    const record: PreparationRecord = {
      commitToken: null,
      expiresAtMs: now + PREPARATION_LIMITS.ttlMs,
      metadata,
      preparationId,
      selectedIndexes: new Set(),
      sourcePolicy: cloneSourcePolicy(input.sourcePolicy),
      state: 'open',
      warnings: combinedWarnings(metadata, input.warnings ?? [])
    }

    this.#recordsById.set(preparationId, record)
    this.#preparationIdByInfoHash.set(metadata.infoHash, preparationId)
    this.#retainedTorrentBytes += metadata.torrentBytes.byteLength
    return this.#snapshot(record)
  }

  get(preparationId: string): PreparationSnapshot {
    return this.#snapshot(this.#activeRecord(preparationId))
  }

  pageFiles(
    preparationId: string,
    request: Readonly<{ cursor: number; limit: number }>
  ): PreparationFilePage {
    if (
      !Number.isSafeInteger(request.cursor) ||
      request.cursor < 0 ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > PREPARATION_LIMITS.filePageSize
    ) {
      throw new PreparationStoreError('INVALID_PAGE')
    }

    const record = this.#activeRecord(preparationId)
    const metadata = this.#metadata(record)
    const items: PreparationFilePage['items'][number][] = []
    let pathBytes = 0
    let offset = request.cursor
    while (
      offset < metadata.files.length &&
      items.length < request.limit &&
      items.length < PREPARATION_LIMITS.filePageSize
    ) {
      const file = metadata.files[offset]
      if (!file) break
      const nextPathBytes = utf8Encoder.encode(file.path).byteLength
      if (
        items.length > 0 &&
        pathBytes + nextPathBytes > PREPARATION_LIMITS.filePagePathBytes
      ) {
        break
      }
      if (nextPathBytes > PREPARATION_LIMITS.filePagePathBytes) {
        throw new PreparationStoreError('INVALID_PAGE')
      }
      items.push({
        downloaded: 0,
        index: file.index,
        length: file.length,
        path: file.path,
        progress: 0,
        selected: record.selectedIndexes.has(file.index)
      })
      pathBytes += nextPathBytes
      offset += 1
    }

    return {
      items,
      nextCursor: offset < metadata.files.length ? offset : null,
      preparationId,
      total: metadata.files.length
    }
  }

  updateSelection(
    preparationId: string,
    changes: ReadonlyArray<SelectionChange>
  ): PreparationSnapshot {
    const record = this.#activeRecord(preparationId)
    if (record.state !== 'open') {
      throw new PreparationStoreError('STATE_CONFLICT')
    }
    if (
      changes.length === 0 ||
      changes.length > PREPARATION_LIMITS.selectionChanges
    ) {
      throw new PreparationStoreError('INVALID_SELECTION')
    }

    const metadata = this.#metadata(record)
    const validIndexes = new Set(metadata.files.map(file => file.index))
    const changedIndexes = new Set<number>()
    for (const change of changes) {
      if (
        !Number.isSafeInteger(change.index) ||
        !validIndexes.has(change.index) ||
        changedIndexes.has(change.index)
      ) {
        throw new PreparationStoreError('INVALID_SELECTION')
      }
      changedIndexes.add(change.index)
    }

    for (const change of changes) {
      if (change.selected) record.selectedIndexes.add(change.index)
      else record.selectedIndexes.delete(change.index)
    }
    return this.#snapshot(record)
  }

  beginCommit(preparationId: string): PreparationCommitReservation {
    const record = this.#activeRecord(preparationId)
    if (record.state !== 'open') {
      throw new PreparationStoreError('STATE_CONFLICT')
    }

    const reservationToken = Symbol(`preparation:${preparationId}`)
    const metadata = this.#metadata(record)
    record.commitToken = reservationToken
    record.state = 'committing'
    return {
      expiresAtMs: record.expiresAtMs,
      // Commit code hands this object to third-party torrent machinery. Keep
      // the store-owned copy isolated so mutation cannot corrupt accounting,
      // duplicate detection, rollback, or a later commit attempt.
      metadata: cloneMetadata(metadata),
      preparationId,
      reservationToken,
      selectedIndexes: [...record.selectedIndexes].sort(
        (left, right) => left - right
      ),
      sourcePolicy: cloneSourcePolicy(record.sourcePolicy),
      warnings: [...record.warnings]
    }
  }

  rollbackCommitBeforeMetadata(
    reservation: PreparationCommitReservation
  ): PreparationSnapshot | null {
    const record = this.#reservedRecord(reservation)
    const expired = this.#currentTime() >= record.expiresAtMs
    if (expired) {
      this.#remove(record)
      return null
    }
    record.commitToken = null
    record.state = 'open'
    return this.#snapshot(record)
  }

  consumeCommit(
    reservation: PreparationCommitReservation
  ): PreparationSnapshot {
    return this.#remove(this.#reservedRecord(reservation))
  }

  discard(preparationId: string): PreparationSnapshot {
    const record = this.#activeRecord(preparationId)
    if (record.state !== 'open') {
      throw new PreparationStoreError('STATE_CONFLICT')
    }
    return this.#remove(record)
  }

  expire(): ReadonlyArray<PreparationSnapshot> {
    const now = this.#currentTime()
    const expired = [...this.#recordsById.values()]
      .filter(record => record.state === 'open' && now >= record.expiresAtMs)
      .sort((left, right) =>
        left.preparationId.localeCompare(right.preparationId)
      )
    return expired.map(record => this.#remove(record))
  }

  clear(): void {
    for (const record of this.#recordsById.values()) {
      record.metadata = null
      record.selectedIndexes.clear()
    }
    this.#recordsById.clear()
    this.#preparationIdByInfoHash.clear()
    this.#retainedTorrentBytes = 0
  }

  get size(): number {
    this.expire()
    return this.#recordsById.size
  }

  get retainedTorrentBytes(): number {
    this.expire()
    return this.#retainedTorrentBytes
  }

  #activeRecord(preparationId: string): PreparationRecord {
    const expiredIds = new Set(
      this.expire().map(preparation => preparation.preparationId)
    )
    if (expiredIds.has(preparationId)) {
      throw new PreparationStoreError('EXPIRED')
    }
    const record = this.#recordsById.get(preparationId)
    if (!record) throw new PreparationStoreError('NOT_FOUND')
    return record
  }

  #currentTime(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('Preparation store clock returned an invalid time')
    }
    return now
  }

  #metadata(record: PreparationRecord): ValidatedTorrentMetadata {
    if (!record.metadata) {
      throw new Error('Preparation metadata was released unexpectedly')
    }
    return record.metadata
  }

  #newPreparationId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const preparationId = this.#createId()
      if (!uuidV4Pattern.test(preparationId)) {
        throw new Error('Preparation id source returned an invalid UUID')
      }
      if (!this.#recordsById.has(preparationId)) return preparationId
    }
    throw new Error('Preparation id source repeatedly returned a collision')
  }

  #remove(record: PreparationRecord): PreparationSnapshot {
    const snapshot = this.#snapshot(record)
    const metadata = this.#metadata(record)
    this.#recordsById.delete(record.preparationId)
    this.#preparationIdByInfoHash.delete(metadata.infoHash)
    this.#retainedTorrentBytes -= metadata.torrentBytes.byteLength
    record.metadata = null
    record.selectedIndexes.clear()
    record.commitToken = null
    return snapshot
  }

  #reservedRecord(
    reservation: PreparationCommitReservation
  ): PreparationRecord {
    const record = this.#recordsById.get(reservation.preparationId)
    if (!record) throw new PreparationStoreError('NOT_FOUND')
    if (
      record.state !== 'committing' ||
      record.commitToken !== reservation.reservationToken
    ) {
      throw new PreparationStoreError('STATE_CONFLICT')
    }
    return record
  }

  #snapshot(record: PreparationRecord): PreparationSnapshot {
    const metadata = this.#metadata(record)
    return {
      expiresAtMs: record.expiresAtMs,
      fileCount: metadata.files.length,
      infoHash: metadata.infoHash,
      length: metadata.length,
      lifecycleState: record.state,
      name: metadata.name,
      preparationId: record.preparationId,
      private: metadata.private,
      selectedFileCount: record.selectedIndexes.size,
      sourcePolicy: cloneSourcePolicy(record.sourcePolicy),
      warnings: [...record.warnings]
    }
  }
}
