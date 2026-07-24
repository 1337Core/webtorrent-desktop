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
import {
  TorrentPreparationService,
  TorrentPreparationServiceError
} from './torrent-preparation-service'

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
  preparationStore?: PreparationStore
}>

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
  #closePromise: Promise<void> | null = null
  #closed = false

  constructor(options: EngineRuntimeOptions = {}) {
    this.#emitEvent = options.emitEvent ?? (() => undefined)
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
    this.#closePromise = Promise.allSettled(activeExecutions).then(() => {
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
      case 'list-torrents':
        return {
          ok: true,
          result: {
            command: 'list-torrents',
            value: {
              items: [],
              nextCursor: null,
              total: 0
            }
          }
        }
      case 'close-media':
      case 'commit-preparation':
      case 'create-torrent':
      case 'get-torrent-files':
      case 'heartbeat-media':
      case 'open-media':
      case 'pause-torrent':
      case 'remove-torrent':
      case 'resume-torrent':
        return errorResult(operation, PUBLIC_ERRORS.unsupported)
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
