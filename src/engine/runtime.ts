import {
  engineCommandResultSchema,
  engineResultMatchesOperation,
  type EngineCommand,
  type EngineCommandResult,
  type EngineEvent
} from '../shared/engine-api'
import {
  PreparationStore,
  PreparationStoreError,
  type PreparationFilePage,
  type PreparationSnapshot
} from './preparation-store'
import { DiskTorrentError } from './disk-torrent'
import {
  TorrentCreationError,
  TorrentCreationService
} from './torrent-creation'
import { TorrentManager, TorrentManagerError } from './torrent-manager'
import {
  TorrentPreparationService,
  TorrentPreparationServiceError
} from './torrent-preparation-service'
import { TorrentRegistryError } from './torrent-registry'

type PreparationService = Pick<TorrentPreparationService, 'open'>
type EngineSuccess = Extract<EngineCommandResult, { ok: true }>['result']
type PreparationSummary = Extract<
  EngineSuccess,
  { command: 'open-preparation' }
>['value']
type PublicPreparationFilePage = Extract<
  EngineSuccess,
  { command: 'get-preparation-files' }
>['value']

type EngineRuntimeOptions = Readonly<{
  createPreparationService?: (store: PreparationStore) => PreparationService
  emitEvent?: (event: EngineEvent) => void
  creationService?: TorrentCreationService
  preparationStore?: PreparationStore
  torrentManager?: TorrentManager
}>

/** Raised when a torrent command arrives before the clients are attached. */
class EngineRuntimeUnavailableError extends Error {
  constructor() {
    super('The torrent engine runtime has no attached clients.')
    this.name = 'EngineRuntimeUnavailableError'
  }
}

type PublicError = Readonly<{
  code: Extract<EngineCommandResult, { ok: false }>['error']['code']
  displayMessage: string
  retryable: boolean
}>

const PUBLIC_ERRORS = Object.freeze({
  aborted: {
    code: 'ABORTED',
    displayMessage: 'The torrent operation was aborted.',
    retryable: false
  },
  alreadyExists: {
    code: 'ALREADY_EXISTS',
    displayMessage: 'This torrent is already being prepared.',
    retryable: false
  },
  capacityExceeded: {
    code: 'STATE_CONFLICT',
    displayMessage: 'Too many torrent preparations are open.',
    retryable: true
  },
  engineNotReady: {
    code: 'ENGINE_NOT_READY',
    displayMessage: 'The torrent engine is not ready.',
    retryable: true
  },
  inputInvalid: {
    code: 'INPUT_INVALID',
    displayMessage: 'The torrent input is invalid.',
    retryable: false
  },
  internal: {
    code: 'INTERNAL',
    displayMessage: 'The torrent engine could not complete the operation.',
    retryable: false
  },
  localTorrentUnavailable: {
    code: 'PATH_NOT_AUTHORIZED',
    displayMessage: 'The selected torrent file is not available.',
    retryable: false
  },
  preparationNotFound: {
    code: 'NOT_FOUND',
    displayMessage: 'The torrent preparation was not found.',
    retryable: false
  },
  remoteConcurrencyLimit: {
    code: 'STATE_CONFLICT',
    displayMessage: 'Too many remote torrent requests are active.',
    retryable: true
  },
  remoteTorrentUnavailable: {
    code: 'NOT_FOUND',
    displayMessage: 'The remote torrent could not be loaded.',
    retryable: true
  },
  creationFailed: {
    code: 'INTERNAL',
    displayMessage: 'The torrent could not be created.',
    retryable: false
  },
  sourceNotAuthorized: {
    code: 'PATH_NOT_AUTHORIZED',
    displayMessage: 'The selected source is not available.',
    retryable: false
  },
  trackerRejected: {
    code: 'INPUT_INVALID',
    displayMessage: 'A selected tracker is not supported.',
    retryable: false
  },
  torrentAddFailed: {
    code: 'INTERNAL',
    displayMessage: 'The torrent could not be started.',
    retryable: false
  },
  torrentMetadataRejected: {
    code: 'INPUT_INVALID',
    displayMessage: 'The torrent metadata did not match its reservation.',
    retryable: false
  },
  torrentTimedOut: {
    code: 'TIMEOUT',
    displayMessage: 'The torrent did not become ready in time.',
    retryable: true
  },
  torrentNotFound: {
    code: 'NOT_FOUND',
    displayMessage: 'The torrent was not found.',
    retryable: false
  },
  torrentStateConflict: {
    code: 'STATE_CONFLICT',
    displayMessage: 'The torrent cannot change state right now.',
    retryable: false
  },
  stateConflict: {
    code: 'STATE_CONFLICT',
    displayMessage:
      'The torrent preparation cannot be changed in its current state.',
    retryable: false
  },
  unsupported: {
    code: 'UNSUPPORTED',
    displayMessage: 'This torrent operation is not available yet.',
    retryable: false
  }
} satisfies Record<string, PublicError>)

function errorResult(
  operation: EngineCommand,
  error: PublicError
): EngineCommandResult {
  return {
    ok: false,
    error: {
      command: operation.command,
      code: error.code,
      displayMessage: error.displayMessage,
      retryable: error.retryable
    }
  }
}

function strictResult(
  operation: EngineCommand,
  candidate: EngineCommandResult
): EngineCommandResult {
  const parsed = engineCommandResultSchema.safeParse(candidate)
  if (parsed.success && engineResultMatchesOperation(parsed.data, operation)) {
    return parsed.data
  }
  return errorResult(operation, PUBLIC_ERRORS.internal)
}

function preparationSummary(snapshot: PreparationSnapshot): PreparationSummary {
  return {
    expiresAtMs: snapshot.expiresAtMs,
    fileCount: snapshot.fileCount,
    infoHash: snapshot.infoHash,
    length: snapshot.length,
    name: snapshot.name,
    preparationId: snapshot.preparationId,
    private: snapshot.private,
    selectedFileCount: snapshot.selectedFileCount,
    warnings: [...snapshot.warnings]
  }
}

function preparationFilePage(
  page: PreparationFilePage
): PublicPreparationFilePage {
  return {
    items: page.items.map(item => ({
      downloaded: item.downloaded,
      index: item.index,
      length: item.length,
      path: item.path,
      progress: item.progress,
      selected: item.selected
    })),
    nextCursor: page.nextCursor,
    preparationId: page.preparationId,
    total: page.total
  }
}

/**
 * Owns command-facing torrent state inside the utility process. The protocol
 * controller provides serialization and deadlines; this boundary translates
 * internal failures into stable, redacted public results.
 */
export class EngineRuntime {
  readonly #emitEvent: (event: EngineEvent) => void
  readonly #lifecycleController = new AbortController()
  readonly #preparationService: PreparationService
  readonly #preparationStore: PreparationStore
  readonly #activeExecutions = new Set<Promise<EngineCommandResult>>()
  readonly #creationService: TorrentCreationService | null
  readonly #torrentManager: TorrentManager | null
  #closePromise: Promise<void> | null = null
  #closed = false

  constructor(options: EngineRuntimeOptions = {}) {
    this.#emitEvent = options.emitEvent ?? (() => undefined)
    this.#creationService = options.creationService ?? null
    this.#torrentManager = options.torrentManager ?? null
    this.#preparationStore = options.preparationStore ?? new PreparationStore()
    this.#preparationService =
      options.createPreparationService?.(this.#preparationStore) ??
      new TorrentPreparationService({ store: this.#preparationStore })
  }

  execute(
    operation: EngineCommand,
    signal: AbortSignal
  ): Promise<EngineCommandResult> {
    if (signal.aborted) {
      return Promise.resolve(
        strictResult(operation, errorResult(operation, PUBLIC_ERRORS.aborted))
      )
    }
    if (this.#closed) {
      return Promise.resolve(
        strictResult(
          operation,
          errorResult(operation, PUBLIC_ERRORS.engineNotReady)
        )
      )
    }

    const executionSignal = AbortSignal.any([
      signal,
      this.#lifecycleController.signal
    ])
    const execution = this.#executeActive(operation, executionSignal)
    this.#activeExecutions.add(execution)
    void execution.then(
      () => {
        this.#activeExecutions.delete(execution)
      },
      () => {
        this.#activeExecutions.delete(execution)
      }
    )
    return execution
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise

    this.#closed = true
    this.#lifecycleController.abort()
    this.#preparationStore.clear()
    const activeExecutions = [...this.#activeExecutions]
    this.#closePromise = Promise.allSettled(activeExecutions)
      .then(async () => {
        await this.#torrentManager?.closeAll()
      })
      .then(() => {
        this.#preparationStore.clear()
      })
    return this.#closePromise
  }

  async #executeActive(
    operation: EngineCommand,
    signal: AbortSignal
  ): Promise<EngineCommandResult> {
    try {
      this.#expirePreparations()
      if (signal.aborted) {
        return strictResult(
          operation,
          errorResult(operation, PUBLIC_ERRORS.aborted)
        )
      }
      return strictResult(operation, await this.#dispatch(operation, signal))
    } catch (error) {
      return strictResult(operation, this.#mapFailure(operation, error, signal))
    }
  }

  async #dispatch(
    operation: EngineCommand,
    signal: AbortSignal
  ): Promise<EngineCommandResult> {
    switch (operation.command) {
      case 'open-preparation':
        return await this.#openPreparation(operation, signal)
      case 'get-preparation-files': {
        const page = preparationFilePage(
          this.#preparationStore.pageFiles(operation.payload.preparationId, {
            cursor: operation.payload.cursor,
            limit: operation.payload.limit
          })
        )
        return {
          ok: true,
          result: {
            command: 'get-preparation-files',
            value: page
          }
        }
      }
      case 'update-preparation-selection': {
        const snapshot = this.#preparationStore.updateSelection(
          operation.payload.preparationId,
          operation.payload.changes
        )
        return {
          ok: true,
          result: {
            command: 'update-preparation-selection',
            value: {
              preparationId: snapshot.preparationId,
              selectedFileCount: snapshot.selectedFileCount
            }
          }
        }
      }
      case 'discard-preparation': {
        const snapshot = this.#preparationStore.discard(
          operation.payload.preparationId
        )
        return {
          ok: true,
          result: {
            command: 'discard-preparation',
            value: {
              discarded: true,
              preparationId: snapshot.preparationId
            }
          }
        }
      }
      case 'list-torrents': {
        const manager = this.#requireManager()
        return {
          ok: true,
          result: {
            command: 'list-torrents',
            value: manager.list(
              operation.payload.cursor,
              operation.payload.limit
            )
          }
        }
      }
      case 'get-torrent-files': {
        const manager = this.#requireManager()
        return {
          ok: true,
          result: {
            command: 'get-torrent-files',
            value: manager.files(
              operation.payload.infoHash,
              operation.payload.cursor,
              operation.payload.limit
            )
          }
        }
      }
      case 'pause-torrent': {
        const manager = this.#requireManager()
        return {
          ok: true,
          result: {
            command: 'pause-torrent',
            value: await manager.pause(operation.payload.infoHash)
          }
        }
      }
      case 'resume-torrent': {
        const manager = this.#requireManager()
        return {
          ok: true,
          result: {
            command: 'resume-torrent',
            value: await manager.resume(operation.payload.infoHash)
          }
        }
      }
      case 'remove-torrent': {
        const manager = this.#requireManager()
        await manager.remove(operation.payload.infoHash)
        this.#emit({
          event: 'torrent-removed',
          payload: { infoHash: operation.payload.infoHash }
        })
        return {
          ok: true,
          result: {
            command: 'remove-torrent',
            value: { infoHash: operation.payload.infoHash, removed: true }
          }
        }
      }
      case 'commit-preparation':
        return await this.#commitPreparation(operation)
      case 'create-torrent':
        return await this.#createTorrent(operation)
      case 'close-media':
      case 'heartbeat-media':
      case 'open-media':
        return errorResult(operation, PUBLIC_ERRORS.unsupported)
    }
  }

  /**
   * Consumes an open preparation exactly once. A failure before the metadata
   * barrier rolls the preparation back to open; a successful commitment
   * consumes its exclusive reservation.
   */
  async #commitPreparation(
    operation: Extract<EngineCommand, { command: 'commit-preparation' }>
  ): Promise<EngineCommandResult> {
    const manager = this.#requireManager()
    const reservation = this.#preparationStore.beginCommit(
      operation.payload.preparationId
    )

    let torrent
    try {
      torrent = await manager.add({
        destinationRoot: operation.payload.destinationRoot,
        metadata: reservation.metadata,
        selectedIndexes: reservation.selectedIndexes
      })
    } catch (error) {
      try {
        this.#preparationStore.rollbackCommitBeforeMetadata(reservation)
      } catch {
        // An exact TTL boundary may already have removed the preparation.
      }
      throw error
    }

    this.#preparationStore.consumeCommit(reservation)
    this.#emit({ event: 'torrent-updated', payload: torrent })
    return {
      ok: true,
      result: {
        command: 'commit-preparation',
        value: {
          preparationId: reservation.preparationId,
          torrent
        }
      }
    }
  }

  /**
   * Creates validated v1 bytes, then adds them through the ordinary guarded
   * path so the new torrent is fully verified before it seeds in place.
   */
  async #createTorrent(
    operation: Extract<EngineCommand, { command: 'create-torrent' }>
  ): Promise<EngineCommandResult> {
    const manager = this.#requireManager()
    const creation = this.#creationService
    if (!creation) throw new EngineRuntimeUnavailableError()

    const created = await creation.create({
      allowHttpTrackers: operation.payload.allowHttpTrackers,
      announceTiers: operation.payload.announceTiers,
      filterJunkFiles: operation.payload.filterJunkFiles,
      private: operation.payload.private,
      sourcePath: operation.payload.sourcePath,
      ...(operation.payload.comment === undefined
        ? {}
        : { comment: operation.payload.comment }),
      ...(operation.payload.name === undefined
        ? {}
        : { name: operation.payload.name })
    })

    const torrent = await manager.add({
      destinationRoot: created.seedRoot,
      metadata: created.metadata,
      selectedIndexes: created.metadata.files.map(file => file.index)
    })
    this.#emit({ event: 'torrent-updated', payload: torrent })
    return {
      ok: true,
      result: {
        command: 'create-torrent',
        value: { operationId: operation.payload.operationId, torrent }
      }
    }
  }

  #requireManager(): TorrentManager {
    if (!this.#torrentManager) {
      throw new EngineRuntimeUnavailableError()
    }
    return this.#torrentManager
  }

  #emit(event: EngineEvent): void {
    try {
      this.#emitEvent(event)
    } catch {
      // A reporting callback cannot fail a completed command.
    }
  }

  async #openPreparation(
    operation: Extract<EngineCommand, { command: 'open-preparation' }>,
    signal: AbortSignal
  ): Promise<EngineCommandResult> {
    if (
      operation.payload.source.kind === 'info-hash' ||
      operation.payload.source.kind === 'magnet'
    ) {
      return errorResult(operation, PUBLIC_ERRORS.unsupported)
    }

    const snapshot = await this.#preparationService.open(
      operation.payload.source,
      signal
    )
    if (signal.aborted || this.#closed) {
      try {
        this.#preparationStore.discard(snapshot.preparationId)
      } catch {
        // Closing or an exact TTL boundary may already have released it.
      }
      return errorResult(operation, PUBLIC_ERRORS.aborted)
    }

    return {
      ok: true,
      result: {
        command: 'open-preparation',
        value: preparationSummary(snapshot)
      }
    }
  }

  #expirePreparations(): void {
    for (const preparation of this.#preparationStore.expire()) {
      try {
        this.#emitEvent({
          event: 'preparation-expired',
          payload: {
            preparationId: preparation.preparationId
          }
        })
      } catch {
        // A reporting callback cannot restore expired state or fail a command.
      }
    }
  }

  #mapFailure(
    operation: EngineCommand,
    error: unknown,
    signal: AbortSignal
  ): EngineCommandResult {
    if (signal.aborted) {
      return errorResult(operation, PUBLIC_ERRORS.aborted)
    }

    if (error instanceof TorrentPreparationServiceError) {
      switch (error.code) {
        case 'ABORTED':
          return errorResult(operation, PUBLIC_ERRORS.aborted)
        case 'ALREADY_EXISTS':
          return errorResult(operation, PUBLIC_ERRORS.alreadyExists)
        case 'CAPACITY_EXCEEDED':
          return errorResult(operation, PUBLIC_ERRORS.capacityExceeded)
        case 'INPUT_INVALID':
          return errorResult(operation, PUBLIC_ERRORS.inputInvalid)
        case 'LOCAL_TORRENT_UNAVAILABLE':
          return errorResult(operation, PUBLIC_ERRORS.localTorrentUnavailable)
        case 'REMOTE_CONCURRENCY_LIMIT':
          return errorResult(operation, PUBLIC_ERRORS.remoteConcurrencyLimit)
        case 'REMOTE_TORRENT_UNAVAILABLE':
          return errorResult(operation, PUBLIC_ERRORS.remoteTorrentUnavailable)
        case 'UNSUPPORTED':
          return errorResult(operation, PUBLIC_ERRORS.unsupported)
        case 'INTERNAL':
          return errorResult(operation, PUBLIC_ERRORS.internal)
      }
    }

    if (error instanceof EngineRuntimeUnavailableError) {
      return errorResult(operation, PUBLIC_ERRORS.engineNotReady)
    }

    if (error instanceof TorrentCreationError) {
      switch (error.code) {
        case 'INPUT_INVALID':
          return errorResult(operation, PUBLIC_ERRORS.inputInvalid)
        case 'PRIVATE_TRACKER_REQUIRED':
        case 'TRACKER_REJECTED':
          return errorResult(operation, PUBLIC_ERRORS.trackerRejected)
        case 'SOURCE_NOT_AUTHORIZED':
          return errorResult(operation, PUBLIC_ERRORS.sourceNotAuthorized)
        case 'CREATION_FAILED':
          return errorResult(operation, PUBLIC_ERRORS.creationFailed)
      }
    }

    if (error instanceof DiskTorrentError) {
      switch (error.code) {
        case 'COMMIT_REJECTED':
          return errorResult(operation, PUBLIC_ERRORS.torrentMetadataRejected)
        case 'READY_TIMEOUT':
          return errorResult(operation, PUBLIC_ERRORS.torrentTimedOut)
        case 'STATE_CONFLICT':
          return errorResult(operation, PUBLIC_ERRORS.torrentStateConflict)
        case 'ADD_FAILED':
        case 'DESTROYED':
        case 'TORRENT_ERROR':
          return errorResult(operation, PUBLIC_ERRORS.torrentAddFailed)
      }
    }

    if (error instanceof TorrentManagerError) {
      switch (error.code) {
        case 'CAPACITY_EXCEEDED':
          return errorResult(operation, PUBLIC_ERRORS.capacityExceeded)
        case 'INPUT_INVALID':
          return errorResult(operation, PUBLIC_ERRORS.inputInvalid)
        case 'NOT_FOUND':
          return errorResult(operation, PUBLIC_ERRORS.torrentNotFound)
        case 'STATE_CONFLICT':
          return errorResult(operation, PUBLIC_ERRORS.torrentStateConflict)
      }
    }

    if (error instanceof TorrentRegistryError) {
      switch (error.code) {
        case 'CAPACITY_EXCEEDED':
          return errorResult(operation, PUBLIC_ERRORS.capacityExceeded)
        case 'DUPLICATE_INFO_HASH':
          return errorResult(operation, PUBLIC_ERRORS.alreadyExists)
        case 'INVALID_INPUT':
          return errorResult(operation, PUBLIC_ERRORS.inputInvalid)
        case 'NOT_FOUND':
          return errorResult(operation, PUBLIC_ERRORS.torrentNotFound)
        case 'STATE_CONFLICT':
          return errorResult(operation, PUBLIC_ERRORS.torrentStateConflict)
      }
    }

    if (error instanceof PreparationStoreError) {
      switch (error.code) {
        case 'DUPLICATE_INFO_HASH':
          return errorResult(operation, PUBLIC_ERRORS.alreadyExists)
        case 'CAPACITY_EXCEEDED':
          return errorResult(operation, PUBLIC_ERRORS.capacityExceeded)
        case 'EXPIRED':
        case 'NOT_FOUND':
          return errorResult(operation, PUBLIC_ERRORS.preparationNotFound)
        case 'INVALID_PAGE':
        case 'INVALID_SELECTION':
          return errorResult(operation, PUBLIC_ERRORS.inputInvalid)
        case 'STATE_CONFLICT':
          return errorResult(operation, PUBLIC_ERRORS.stateConflict)
        case 'INVALID_WARNING':
          return errorResult(operation, PUBLIC_ERRORS.internal)
      }
    }

    return errorResult(operation, PUBLIC_ERRORS.internal)
  }
}
