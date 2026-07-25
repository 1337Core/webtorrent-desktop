import path from 'node:path'
import type {
  EngineCommand,
  EngineCommandResult,
  TorrentRecord
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { AppStateStore } from './state-store'

export type TorrentLibraryOptions = Readonly<{
  diagnostics: Diagnostics
  now?: () => number
  stateStore: AppStateStore
}>

export type RestoreReport = Readonly<{
  dropped: number
  restored: number
}>

/**
 * The durable torrent library from section 10.1. Main owns identity,
 * destination, and status intent; the engine owns the torrent bytes and the
 * saved selection in its fork-owned files.
 *
 * The library is maintained from the command traffic main already validates,
 * so nothing new crosses a boundary to keep it current, and no path the
 * renderer never sent is ever recorded.
 */
export class TorrentLibrary {
  readonly #diagnostics: Diagnostics
  readonly #now: () => number
  readonly #stateStore: AppStateStore

  constructor(options: TorrentLibraryOptions) {
    this.#diagnostics = options.diagnostics
    this.#now = options.now ?? (() => Date.now())
    this.#stateStore = options.stateStore
  }

  /** Folds one completed command into the library. */
  record(operation: EngineCommand, result: EngineCommandResult): void {
    if (!result.ok) return
    const success = result.result

    try {
      switch (operation.command) {
        case 'commit-preparation':
          if (success.command !== 'commit-preparation') return
          this.#upsert(operation.payload.destinationRoot, success.value.torrent)
          return
        case 'create-torrent':
          if (success.command !== 'create-torrent') return
          // Creation seeds the data where it already lives, so the torrent's
          // root is the parent of the chosen source (section 9.6).
          this.#upsert(
            path.dirname(operation.payload.sourcePath),
            success.value.torrent
          )
          return
        case 'import-legacy-torrent':
          if (success.command !== 'import-legacy-torrent') return
          this.#upsert(operation.payload.destinationRoot, success.value.torrent)
          return
        case 'pause-torrent':
        case 'resume-torrent':
          this.#setPaused(
            operation.payload.infoHash,
            operation.command === 'pause-torrent'
          )
          return
        case 'remove-torrent':
          this.#stateStore.removeTorrent(operation.payload.infoHash)
          return
        default:
          return
      }
    } catch (error) {
      // A full or unwritable library must not fail the torrent command that
      // already succeeded; the next restart simply knows less.
      this.#diagnostics.warn('library.record-failed', {
        command: operation.command,
        reason: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  /**
   * Rebuilds every recorded torrent through the engine. A torrent whose
   * archived bytes are gone is dropped from the library rather than left as a
   * row that can never load.
   */
  async restore(
    execute: (operation: EngineCommand) => Promise<EngineCommandResult>
  ): Promise<RestoreReport> {
    let restored = 0
    let dropped = 0

    for (const record of this.#stateStore.listTorrents()) {
      const result = await execute({
        command: 'restore-torrent',
        payload: {
          destinationRoot: record.destinationRoot,
          infoHash: record.infoHash,
          paused: record.paused
        }
      })
      if (result.ok) {
        restored += 1
        continue
      }
      if (result.error.code === 'NOT_FOUND') {
        this.#stateStore.removeTorrent(record.infoHash)
        dropped += 1
        continue
      }
      this.#diagnostics.warn('library.restore-failed', {
        code: result.error.code
      })
    }

    this.#diagnostics.info('library.restored', { dropped, restored })
    return { dropped, restored }
  }

  #upsert(
    destinationRoot: string,
    torrent: Readonly<{
      infoHash: string
      name: string
      private: boolean
      state: string
    }>
  ): void {
    const existing = this.#stateStore
      .listTorrents()
      .find(record => record.infoHash === torrent.infoHash)
    const record: TorrentRecord = {
      addedAtMs: existing?.addedAtMs ?? this.#now(),
      destinationRoot,
      infoHash: torrent.infoHash,
      name: torrent.name,
      paused: torrent.state === 'paused',
      private: torrent.private
    }
    this.#stateStore.upsertTorrent(record)
  }

  #setPaused(infoHash: string, paused: boolean): void {
    const existing = this.#stateStore
      .listTorrents()
      .find(record => record.infoHash === infoHash)
    if (!existing || existing.paused === paused) return
    this.#stateStore.upsertTorrent({ ...existing, paused })
  }
}
