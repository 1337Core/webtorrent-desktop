import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { ChunkStore, ChunkStoreCallback } from 'webtorrent'

type GuardedStoreFile = Readonly<{
  index: number
  length: number
  offset: number
  path: string
}>

export type GuardedStoreGrant = Readonly<{
  chunkLength: number
  files: ReadonlyArray<GuardedStoreFile>
  root: string
  totalLength: number
}>

type GuardedStoreFaultCode =
  | 'GRANT_MISMATCH'
  | 'GEOMETRY_MISMATCH'
  | 'MULTIPLE_INSTANCES'
  | 'OPTIONS_MUTATED'

export type GuardedStoreFault = Readonly<{
  code: GuardedStoreFaultCode
  detail: string
}>

export type GuardedStoreErrorCode =
  | 'ACCESS_DENIED'
  | 'IO_FAILED'
  | 'NOT_FOUND'
  | 'OUT_OF_RANGE'
  | 'STORE_FAULTED'
  | 'STORE_CLOSED'

export class GuardedStoreError extends Error {
  readonly code: GuardedStoreErrorCode

  constructor(code: GuardedStoreErrorCode) {
    super(`Guarded torrent store operation failed: ${code}.`)
    this.name = 'GuardedStoreError'
    this.code = code
  }
}

type ResolvedFile = GuardedStoreFile & {
  absolutePath: string
  segments: ReadonlyArray<string>
}

type ChunkSlice = Readonly<{
  chunkOffset: number
  file: ResolvedFile
  fileOffset: number
  length: number
}>

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/**
 * macOS exposes O_NOFOLLOW, so the final component of every payload open
 * refuses to traverse a symlink placed under the authorized root.
 */
const NO_FOLLOW = fsConstants.O_NOFOLLOW

function normalizeGrantPath(root: string, value: string): ResolvedFile | null {
  if (typeof value !== 'string' || value === '') return null
  const segments = value.split('/')
  if (
    segments.some(
      segment =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        segment.includes('\0')
    )
  ) {
    return null
  }

  const absolutePath = path.resolve(root, ...segments)
  const relative = path.relative(root, absolutePath)
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return null
  }
  return {
    absolutePath,
    index: -1,
    length: 0,
    offset: 0,
    path: value,
    segments
  }
}

function ioError(error: unknown): GuardedStoreError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  if (code === 'ENOENT') return new GuardedStoreError('NOT_FOUND')
  if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
    return new GuardedStoreError('ACCESS_DENIED')
  }
  return new GuardedStoreError('IO_FAILED')
}

/**
 * Creates and supervises the app-owned chunk store for exactly one torrent
 * add.
 *
 * WebTorrent constructs the store itself, so the constructor must never throw:
 * an invariant failure is recorded here and read by the synchronous metadata
 * commit barrier, which destroys the torrent before verification can run.
 */
export class GuardedStoreSupervisor {
  readonly #faults: GuardedStoreFault[] = []
  readonly #files: ReadonlyArray<ResolvedFile>
  readonly #grant: GuardedStoreGrant
  readonly #grantToken = Symbol('guarded-store-grant')
  #instance: GuardedStore | null = null

  constructor(grant: GuardedStoreGrant) {
    if (
      !path.isAbsolute(grant.root) ||
      !Number.isSafeInteger(grant.chunkLength) ||
      grant.chunkLength < 1 ||
      !Number.isSafeInteger(grant.totalLength) ||
      grant.totalLength < 0
    ) {
      throw new GuardedStoreError('ACCESS_DENIED')
    }

    const root = path.resolve(grant.root)
    const files: ResolvedFile[] = []
    let expectedOffset = 0
    for (const file of grant.files) {
      const resolved = normalizeGrantPath(root, file.path)
      if (
        !resolved ||
        !Number.isSafeInteger(file.length) ||
        file.length < 0 ||
        file.offset !== expectedOffset
      ) {
        throw new GuardedStoreError('ACCESS_DENIED')
      }
      files.push({
        ...resolved,
        index: file.index,
        length: file.length,
        offset: file.offset
      })
      expectedOffset += file.length
    }
    if (expectedOffset !== grant.totalLength) {
      throw new GuardedStoreError('ACCESS_DENIED')
    }

    this.#files = files
    this.#grant = { ...grant, files: [...grant.files], root }
  }

  /**
   * Passed to WebTorrent as `storeOpts`. The token proves the options object
   * reaching the constructor is the one this supervisor issued.
   */
  get storeOptions(): Readonly<{ guardedStoreToken: symbol }> {
    return { guardedStoreToken: this.#grantToken }
  }

  get faults(): ReadonlyArray<GuardedStoreFault> {
    return [...this.#faults]
  }

  get instance(): GuardedStore | null {
    return this.#instance
  }

  /**
   * The constructor handed to WebTorrent. It binds this supervisor rather than
   * reading any ambient state.
   */
  storeConstructor(): new (
    chunkLength: number,
    options: { length: number; guardedStoreToken?: symbol }
  ) => ChunkStore {
    const supervisor = this
    return class BoundGuardedStore extends GuardedStore {
      constructor(
        chunkLength: number,
        options: { length: number; guardedStoreToken?: symbol }
      ) {
        super(supervisor, chunkLength, options)
      }
    }
  }

  /**
   * Selected zero-length files exist only after the commit barrier; an absent
   * deselected zero-length file is never created.
   */
  async materializeSelected(
    selectedIndexes: ReadonlyArray<number>
  ): Promise<void> {
    const selected = new Set(selectedIndexes)
    for (const file of this.#files) {
      if (file.length !== 0 || !selected.has(file.index)) continue
      const handle = await this.#openForWrite(file)
      await handle.close()
    }
  }

  async close(): Promise<void> {
    await this.#instance?.closeAsync()
  }

  /** @internal */
  recordFault(fault: GuardedStoreFault): void {
    this.#faults.push(fault)
  }

  /** @internal */
  register(store: GuardedStore, token: symbol | undefined): boolean {
    if (token !== this.#grantToken) {
      this.recordFault({
        code: 'GRANT_MISMATCH',
        detail: 'The store options did not carry the issued grant token.'
      })
      return false
    }
    if (this.#instance) {
      this.recordFault({
        code: 'MULTIPLE_INSTANCES',
        detail: 'A second store instance was constructed for one add.'
      })
      return false
    }
    this.#instance = store
    return true
  }

  /** @internal */
  get grant(): GuardedStoreGrant {
    return this.#grant
  }

  /** @internal */
  get resolvedFiles(): ReadonlyArray<ResolvedFile> {
    return this.#files
  }

  /** @internal */
  async openForRead(file: ResolvedFile): Promise<FileHandle> {
    await this.#verifyExistingParents(file)
    return await open(file.absolutePath, fsConstants.O_RDONLY | NO_FOLLOW)
  }

  /** @internal */
  async openForWrite(file: ResolvedFile): Promise<FileHandle> {
    return await this.#openForWrite(file)
  }

  async #openForWrite(file: ResolvedFile): Promise<FileHandle> {
    await this.#createParents(file)
    return await open(
      file.absolutePath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | NO_FOLLOW,
      FILE_MODE
    )
  }

  /**
   * Reads never create a directory. Every existing component is rechecked
   * immediately before the payload open so a parent replaced by a symlink
   * fails closed.
   */
  async #verifyExistingParents(file: ResolvedFile): Promise<void> {
    let current = this.#grant.root
    for (const segment of file.segments.slice(0, -1)) {
      current = path.join(current, segment)
      const stats = await lstat(current)
      if (!stats.isDirectory()) {
        throw new GuardedStoreError('ACCESS_DENIED')
      }
    }
  }

  async #createParents(file: ResolvedFile): Promise<void> {
    let current = this.#grant.root
    for (const segment of file.segments.slice(0, -1)) {
      current = path.join(current, segment)
      try {
        const stats = await lstat(current)
        if (!stats.isDirectory()) {
          throw new GuardedStoreError('ACCESS_DENIED')
        }
        continue
      } catch (error) {
        if (error instanceof GuardedStoreError) throw error
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        if (code !== 'ENOENT') throw ioError(error)
      }

      try {
        await mkdir(current, { mode: DIRECTORY_MODE })
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        if (code !== 'EEXIST') throw ioError(error)
      }

      // Recheck identity after creation: a concurrent actor may have won the
      // race and replaced the component with a link.
      const stats = await lstat(current)
      if (!stats.isDirectory()) {
        throw new GuardedStoreError('ACCESS_DENIED')
      }
    }
  }
}

/**
 * A minimal chunk store over the already validated manifest. It is not a
 * wrapper around `fs-chunk-store`: no stock read path may create directories
 * for absent deselected files, and no operation may leave the authorized root.
 */
export class GuardedStore implements ChunkStore {
  readonly chunkLength: number
  readonly length: number
  readonly #handles = new Map<
    number,
    { handle: FileHandle; writable: boolean }
  >()
  readonly #supervisor: GuardedStoreSupervisor
  #closed = false
  #faulted = false

  constructor(
    supervisor: GuardedStoreSupervisor,
    chunkLength: number,
    options: { length: number; guardedStoreToken?: symbol }
  ) {
    this.#supervisor = supervisor
    this.chunkLength = chunkLength
    this.length = options.length

    if (!supervisor.register(this, options.guardedStoreToken)) {
      this.#faulted = true
      return
    }
    if (
      chunkLength !== supervisor.grant.chunkLength ||
      options.length !== supervisor.grant.totalLength
    ) {
      supervisor.recordFault({
        code: 'GEOMETRY_MISMATCH',
        detail: `Expected ${supervisor.grant.chunkLength}/${supervisor.grant.totalLength}, received ${chunkLength}/${options.length}.`
      })
      this.#faulted = true
    }
  }

  get faulted(): boolean {
    return this.#faulted
  }

  get(
    index: number,
    options:
      | { length?: number; offset?: number }
      | ((error: Error | null, data?: Uint8Array) => void),
    callback?: (error: Error | null, data?: Uint8Array) => void
  ): void {
    const resolved =
      typeof options === 'function'
        ? { done: options, range: {} }
        : { done: callback, range: options }
    const done = resolved.done
    if (!done) return
    void this.#read(index, resolved.range).then(
      data => done(null, data),
      (error: unknown) => done(error as Error)
    )
  }

  put(index: number, data: Uint8Array, callback?: ChunkStoreCallback): void {
    void this.#write(index, data).then(
      () => callback?.(null),
      (error: unknown) => callback?.(error as Error)
    )
  }

  close(callback?: ChunkStoreCallback): void {
    void this.closeAsync().then(
      () => callback?.(null),
      (error: unknown) => callback?.(error as Error)
    )
  }

  /** Payload deletion is a separate main-authorized Trash operation. */
  destroy(callback?: ChunkStoreCallback): void {
    this.close(callback)
  }

  async closeAsync(): Promise<void> {
    this.#closed = true
    const handles = [...this.#handles.values()]
    this.#handles.clear()
    for (const { handle } of handles) {
      try {
        await handle.close()
      } catch {
        // A close failure cannot be repaired and never deletes payload.
      }
    }
  }

  async #read(
    index: number,
    range: { length?: number; offset?: number }
  ): Promise<Uint8Array> {
    const slices = this.#slices(index, range)
    const total = slices.reduce((sum, slice) => sum + slice.length, 0)
    const buffer = new Uint8Array(total)
    for (const slice of slices) {
      const handle = await this.#handle(slice.file, false)
      const target = buffer.subarray(
        slice.chunkOffset,
        slice.chunkOffset + slice.length
      )
      const { bytesRead } = await handle
        .read(target, 0, slice.length, slice.fileOffset)
        .catch((error: unknown) => {
          throw ioError(error)
        })
      if (bytesRead !== slice.length) {
        throw new GuardedStoreError('NOT_FOUND')
      }
    }
    return buffer
  }

  async #write(index: number, data: Uint8Array): Promise<void> {
    if (!(data instanceof Uint8Array)) {
      throw new GuardedStoreError('OUT_OF_RANGE')
    }
    const slices = this.#slices(index, {})
    const expected = slices.reduce((sum, slice) => sum + slice.length, 0)
    if (data.byteLength !== expected) {
      throw new GuardedStoreError('OUT_OF_RANGE')
    }
    for (const slice of slices) {
      const handle = await this.#handle(slice.file, true)
      await handle
        .write(
          data.subarray(slice.chunkOffset, slice.chunkOffset + slice.length),
          0,
          slice.length,
          slice.fileOffset
        )
        .catch((error: unknown) => {
          throw ioError(error)
        })
    }
  }

  async #handle(file: ResolvedFile, forWrite: boolean): Promise<FileHandle> {
    const existing = this.#handles.get(file.index)
    if (existing && (existing.writable || !forWrite)) return existing.handle
    if (existing) {
      this.#handles.delete(file.index)
      await existing.handle.close().catch(() => undefined)
    }

    const handle = await (
      forWrite
        ? this.#supervisor.openForWrite(file)
        : this.#supervisor.openForRead(file)
    ).catch((error: unknown) => {
      throw error instanceof GuardedStoreError ? error : ioError(error)
    })
    this.#handles.set(file.index, { handle, writable: forWrite })
    return handle
  }

  #slices(
    index: number,
    range: { length?: number; offset?: number }
  ): ReadonlyArray<ChunkSlice> {
    if (this.#faulted) throw new GuardedStoreError('STORE_FAULTED')
    if (this.#closed) throw new GuardedStoreError('STORE_CLOSED')
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new GuardedStoreError('OUT_OF_RANGE')
    }

    const chunkStart = index * this.chunkLength
    if (chunkStart >= this.length && this.length !== 0) {
      throw new GuardedStoreError('OUT_OF_RANGE')
    }
    const chunkBytes = Math.min(this.chunkLength, this.length - chunkStart)
    const offset = range.offset ?? 0
    const length = range.length ?? chunkBytes - offset
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > chunkBytes
    ) {
      throw new GuardedStoreError('OUT_OF_RANGE')
    }

    const start = chunkStart + offset
    const end = start + length
    const slices: ChunkSlice[] = []
    for (const file of this.#supervisor.resolvedFiles) {
      if (file.length === 0) continue
      const fileEnd = file.offset + file.length
      if (fileEnd <= start || file.offset >= end) continue
      const sliceStart = Math.max(start, file.offset)
      const sliceEnd = Math.min(end, fileEnd)
      slices.push({
        chunkOffset: sliceStart - start,
        file,
        fileOffset: sliceStart - file.offset,
        length: sliceEnd - sliceStart
      })
    }
    return slices
  }
}
