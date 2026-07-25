import type { EngineCommandResult } from '../shared/engine-api'
import {
  DiskTorrentError,
  DiskTorrentSession,
  type DiskTorrentSessionOptions,
  type EngineAddClient
} from './disk-torrent'
import type { ValidatedTorrentMetadata } from './torrent-metadata'
import { TorrentRegistry, type TorrentOwner } from './torrent-registry'

type EngineSuccess = Extract<EngineCommandResult, { ok: true }>['result']

export type TorrentSummary = Extract<
  EngineSuccess,
  { command: 'pause-torrent' }
>['value']

export type TorrentFilePage = Extract<
  EngineSuccess,
  { command: 'get-torrent-files' }
>['value']

export type TorrentSummaryPage = Extract<
  EngineSuccess,
  { command: 'list-torrents' }
>['value']

export type TorrentManagerErrorCode =
  'CAPACITY_EXCEEDED' | 'INPUT_INVALID' | 'NOT_FOUND' | 'STATE_CONFLICT'

export class TorrentManagerError extends Error {
  readonly code: TorrentManagerErrorCode

  constructor(code: TorrentManagerErrorCode) {
    super(`Torrent manager operation failed: ${code}.`)
    this.name = 'TorrentManagerError'
    this.code = code
  }
}

export type TorrentManagerOptions = Readonly<{
  registry?: TorrentRegistry
  resolveClient: (owner: TorrentOwner) => EngineAddClient
  sessionOptions?: Omit<DiskTorrentSessionOptions, 'registry'>
}>

export type TorrentAddRequest = Readonly<{
  destinationRoot: string
  metadata: ValidatedTorrentMetadata
  selectedIndexes: ReadonlyArray<number>
}>

const MAX_PAGE_SIZE = 64
const MAX_PAGE_PATH_BYTES = 40_960
const MAX_PAGE_NAME_BYTES = 16_384
const utf8Encoder = new TextEncoder()

/**
 * Owns every disk-backed torrent session and renders them as the bounded
 * contract DTOs the renderer receives. Ordering is by info hash so a page
 * cursor stays stable while torrents are added or removed.
 */
export class TorrentManager {
  readonly #registry: TorrentRegistry
  readonly #resolveClient: (owner: TorrentOwner) => EngineAddClient
  readonly #sessionOptions: Omit<DiskTorrentSessionOptions, 'registry'>
  readonly #sessions = new Map<string, DiskTorrentSession>()

  constructor(options: TorrentManagerOptions) {
    this.#registry = options.registry ?? new TorrentRegistry()
    this.#resolveClient = options.resolveClient
    this.#sessionOptions = options.sessionOptions ?? {}
  }

  get registry(): TorrentRegistry {
    return this.#registry
  }

  get size(): number {
    return this.#sessions.size
  }

  async add(request: TorrentAddRequest): Promise<TorrentSummary> {
    const owner: TorrentOwner = request.metadata.private ? 'private' : 'public'
    const session = await DiskTorrentSession.add(
      {
        client: this.#resolveClient(owner),
        downloadRoot: request.destinationRoot,
        metadata: request.metadata,
        owner,
        selectedIndexes: request.selectedIndexes
      },
      { ...this.#sessionOptions, registry: this.#registry }
    )
    this.#sessions.set(session.infoHash, session)
    return this.#summary(session)
  }

  summary(infoHash: string): TorrentSummary {
    return this.#summary(this.#require(infoHash))
  }

  list(cursor: number, limit: number): TorrentSummaryPage {
    const ordered = [...this.#sessions.values()].sort((left, right) =>
      left.infoHash.localeCompare(right.infoHash)
    )
    const start = this.#pageStart(cursor)
    const items: TorrentSummary[] = []
    let nameBytes = 0
    let index = start
    for (
      ;
      index < ordered.length && items.length < this.#pageLimit(limit);
      index += 1
    ) {
      const session = ordered[index]
      if (!session) break
      const summary = this.#summary(session)
      nameBytes += utf8Encoder.encode(summary.name).byteLength
      if (nameBytes > MAX_PAGE_NAME_BYTES && items.length > 0) break
      items.push(summary)
    }
    return {
      items,
      nextCursor: index < ordered.length ? index : null,
      total: ordered.length
    }
  }

  files(infoHash: string, cursor: number, limit: number): TorrentFilePage {
    const session = this.#require(infoHash)
    const files = session.metadata.files
    const stats = session.stats()
    const selected = new Set(session.selectedIndexes)
    const start = this.#pageStart(cursor)

    const items: TorrentFilePage['items'][number][] = []
    let pathBytes = 0
    let index = start
    for (
      ;
      index < files.length && items.length < this.#pageLimit(limit);
      index += 1
    ) {
      const file = files[index]
      if (!file) break
      pathBytes += utf8Encoder.encode(file.path).byteLength
      if (pathBytes > MAX_PAGE_PATH_BYTES && items.length > 0) break
      const downloaded = stats.fileDownloaded[index] ?? 0
      items.push({
        downloaded,
        index: file.index,
        length: file.length,
        path: file.path,
        progress: file.length === 0 ? 1 : downloaded / file.length,
        selected: selected.has(file.index)
      })
    }
    return {
      infoHash: session.infoHash,
      items,
      nextCursor: index < files.length ? index : null,
      total: files.length
    }
  }

  async pause(infoHash: string): Promise<TorrentSummary> {
    const session = this.#require(infoHash)
    await this.#guard(() => session.pause())
    return this.#summary(session)
  }

  async resume(infoHash: string): Promise<TorrentSummary> {
    const session = this.#require(infoHash)
    await this.#guard(() => {
      session.resume()
    })
    return this.#summary(session)
  }

  async remove(infoHash: string): Promise<void> {
    const session = this.#require(infoHash)
    await this.#guard(() => session.remove())
    this.#sessions.delete(infoHash)
  }

  updateSelection(
    infoHash: string,
    selectedIndexes: ReadonlyArray<number>
  ): TorrentSummary {
    const session = this.#require(infoHash)
    const known = new Set(session.metadata.files.map(file => file.index))
    if (selectedIndexes.some(index => !known.has(index))) {
      throw new TorrentManagerError('INPUT_INVALID')
    }
    session.updateSelection(selectedIndexes)
    return this.#summary(session)
  }

  /** Removes every session in a bounded, failure-tolerant sweep. */
  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    for (const session of sessions) {
      try {
        await session.remove()
      } catch {
        // Shutdown continues through a failing teardown and reports later.
      }
    }
  }

  #require(infoHash: string): DiskTorrentSession {
    const session = this.#sessions.get(infoHash)
    if (!session) throw new TorrentManagerError('NOT_FOUND')
    return session
  }

  async #guard(operation: () => Promise<void> | void): Promise<void> {
    try {
      await operation()
    } catch (error) {
      if (error instanceof DiskTorrentError) {
        throw new TorrentManagerError(
          error.code === 'STATE_CONFLICT' ? 'STATE_CONFLICT' : 'NOT_FOUND'
        )
      }
      throw error
    }
  }

  /** A cursor past the end is an empty page, matching the preparation store. */
  #pageStart(cursor: number): number {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TorrentManagerError('INPUT_INVALID')
    }
    return cursor
  }

  #pageLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new TorrentManagerError('INPUT_INVALID')
    }
    return limit
  }

  #summary(session: DiskTorrentSession): TorrentSummary {
    const stats = session.stats()
    const metadata = session.metadata
    return {
      downloadSpeed: stats.downloadSpeed,
      downloaded: stats.downloaded,
      fileCount: metadata.files.length,
      infoHash: metadata.infoHash,
      length: metadata.length,
      name: metadata.name,
      peerCount: stats.numPeers,
      private: metadata.private,
      progress: stats.progress,
      selectedFileCount: session.selectedIndexes.length,
      state: summaryState(session.state, stats.done),
      timeRemainingMs: stats.timeRemainingMs,
      uploadSpeed: stats.uploadSpeed,
      uploaded: stats.uploaded
    }
  }
}

function summaryState(
  state: DiskTorrentSession['state'],
  done: boolean
): TorrentSummary['state'] {
  switch (state) {
    case 'adding':
      return 'checking'
    case 'paused':
      return 'paused'
    case 'removed':
    case 'removing':
      return 'stopped'
    case 'running':
      return done ? 'seeding' : 'downloading'
  }
}
