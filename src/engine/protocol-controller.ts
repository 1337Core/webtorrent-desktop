import { randomUUID } from 'node:crypto'
import {
  ENGINE_MESSAGE_BUDGET,
  engineChildMessageSchema,
  engineCommandResultSchema,
  engineParentMessageSchema,
  engineResultMatchesOperation,
  PROTOCOL_VERSION,
  type EngineChildMessage,
  type EngineCommand,
  type EngineCommandResult,
  type EngineEvent,
  type EngineParentMessage,
  type EngineRuntimeInfo
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'
import {
  EngineOperationAbortedError,
  EngineOperationQueue,
  EngineQueueClosedError
} from './operation-queue'

const MAX_OPERATION_WINDOW_MS = 24 * 60 * 60 * 1_000
const MAX_ACTIVE_OPERATIONS = 128
const MAX_RECENT_REQUEST_IDS = 4_096

type ExecuteOperation = (
  operation: EngineCommand,
  signal: AbortSignal
) => Promise<EngineCommandResult>

type EngineProtocolControllerOptions = {
  execute: ExecuteOperation
  exit: (code: number) => void
  now?: () => number
  postMessage: (message: EngineChildMessage) => void
  proveRuntime: () => Promise<EngineRuntimeInfo>
  shutdown?: () => Promise<void>
}

type CorrelatedChildMessage = Exclude<
  EngineChildMessage,
  { type: 'engine:event' }
>
type CorrelatedChildPartial = {
  [Type in CorrelatedChildMessage['type']]: Pick<
    Extract<CorrelatedChildMessage, { type: Type }>,
    'type' | 'requestId' | 'payload'
  >
}[CorrelatedChildMessage['type']]
type EventChildPartial = Pick<
  Extract<EngineChildMessage, { type: 'engine:event' }>,
  'type' | 'eventId' | 'causeRequestId' | 'payload'
>
type OperationOutcome =
  | { kind: 'error'; error: unknown }
  | { kind: 'ignored' }
  | { kind: 'invalid' }
  | { kind: 'result'; result: EngineCommandResult }
  | { kind: 'timeout' }

function operationError(
  operation: EngineCommand,
  code: Extract<EngineCommandResult, { ok: false }>['error']['code'],
  displayMessage: string,
  retryable: boolean
): EngineCommandResult {
  return {
    ok: false,
    error: {
      command: operation.command,
      code,
      displayMessage,
      retryable
    }
  }
}

/**
 * Owns the utility-process wire protocol. Control traffic is dispatched
 * immediately while application operations use one conservative serial lane.
 * The runtime adds narrower domain reservations only after it resolves IDs.
 */
export class EngineProtocolController {
  readonly #execute: ExecuteOperation
  readonly #exit: (code: number) => void
  readonly #now: () => number
  readonly #postMessage: (message: EngineChildMessage) => void
  readonly #proveRuntime: () => Promise<EngineRuntimeInfo>
  readonly #shutdownRuntime: () => Promise<void>
  readonly #queue = new EngineOperationQueue()
  #generationId: string | null = null
  #inboundSequence = -1
  #outboundSequence = 0
  #initializing = false
  #initialized = false
  #shuttingDown = false
  #exited = false
  readonly #recentRequestIds = new Set<string>()

  constructor(options: EngineProtocolControllerOptions) {
    this.#execute = options.execute
    this.#exit = options.exit
    this.#now = options.now ?? Date.now
    this.#postMessage = options.postMessage
    this.#proveRuntime = options.proveRuntime
    this.#shutdownRuntime = options.shutdown ?? (() => Promise.resolve())
  }

  receive(value: unknown): void {
    if (this.#exited) return
    if (!checkPayloadBudget(value, ENGINE_MESSAGE_BUDGET).ok) {
      this.#fatalExit()
      return
    }

    const parsed = engineParentMessageSchema.safeParse(value)
    if (!parsed.success) {
      this.#fatalExit()
      return
    }
    const message = parsed.data
    if (
      message.sequence <= this.#inboundSequence ||
      this.#recentRequestIds.has(message.requestId) ||
      (this.#generationId !== null &&
        message.generationId !== this.#generationId) ||
      (this.#generationId === null && message.type !== 'engine:initialize')
    ) {
      this.#fatalExit()
      return
    }

    this.#rememberRequestId(message.requestId)
    if (this.#generationId === null) {
      this.#generationId = message.generationId
    }
    this.#inboundSequence = message.sequence

    switch (message.type) {
      case 'engine:initialize':
        this.#initialize(message)
        break
      case 'engine:ping':
        this.#ping(message)
        break
      case 'engine:execute':
        this.#dispatchOperation(message)
        break
      case 'engine:shutdown':
        this.#shutdown(message)
        break
    }
  }

  emit(event: EngineEvent, causeRequestId?: string): boolean {
    if (!this.#initialized || this.#shuttingDown || this.#exited) return false
    return this.#postEvent(event, causeRequestId)
  }

  #initialize(
    message: Extract<EngineParentMessage, { type: 'engine:initialize' }>
  ): void {
    if (this.#initializing || this.#initialized || this.#shuttingDown) {
      this.#postCorrelated({
        type: 'engine:failed',
        requestId: message.requestId,
        payload: {
          code: 'INVALID_MESSAGE',
          message: 'Torrent engine was initialized more than once.'
        }
      })
      return
    }

    this.#initializing = true
    void this.#proveRuntime()
      .then(runtime => {
        if (this.#shuttingDown || this.#exited) return
        this.#initialized = true
        this.#postCorrelated({
          type: 'engine:ready',
          requestId: message.requestId,
          payload: runtime
        })
      })
      .catch((error: unknown) => {
        if (this.#shuttingDown || this.#exited) return
        const code =
          error instanceof Error &&
          error.message === 'NATIVE_WEBRTC_UNAVAILABLE'
            ? 'NATIVE_WEBRTC_UNAVAILABLE'
            : error instanceof Error && error.message === 'RUNTIME_MISMATCH'
              ? 'RUNTIME_MISMATCH'
              : 'START_FAILED'
        this.#postCorrelated({
          type: 'engine:failed',
          requestId: message.requestId,
          payload: {
            code,
            message: 'Torrent engine failed its startup capability check.'
          }
        })
      })
      .finally(() => {
        this.#initializing = false
      })
  }

  #ping(message: Extract<EngineParentMessage, { type: 'engine:ping' }>): void {
    if (!this.#initialized || this.#shuttingDown) {
      this.#postCorrelated({
        type: 'engine:failed',
        requestId: message.requestId,
        payload: {
          code: 'INVALID_MESSAGE',
          message: 'Torrent engine received a ping while it was not ready.'
        }
      })
      return
    }
    this.#postCorrelated({
      type: 'engine:pong',
      requestId: message.requestId,
      payload: {}
    })
  }

  #dispatchOperation(
    message: Extract<EngineParentMessage, { type: 'engine:execute' }>
  ): void {
    const { deadlineMs, operation } = message.payload
    if (!this.#initialized || this.#shuttingDown) {
      this.#postResult(
        message.requestId,
        operationError(
          operation,
          'ENGINE_NOT_READY',
          'The torrent engine is not ready.',
          true
        )
      )
      return
    }
    if (this.#queue.pendingCount >= MAX_ACTIVE_OPERATIONS) {
      this.#postResult(
        message.requestId,
        operationError(
          operation,
          'STATE_CONFLICT',
          'The torrent engine has too many active operations.',
          true
        )
      )
      return
    }

    const remainingMs = deadlineMs - this.#now()
    if (remainingMs > MAX_OPERATION_WINDOW_MS) {
      this.#fatalExit()
      return
    }
    if (remainingMs <= 0) {
      this.#postResult(
        message.requestId,
        operationError(
          operation,
          'TIMEOUT',
          'The torrent operation timed out.',
          true
        )
      )
      return
    }

    const deadlineController = new AbortController()
    const timeout = setTimeout(() => {
      deadlineController.abort()
    }, remainingMs)
    const execution = this.#queue.run(
      'engine-operation',
      signal => this.#execute(operation, signal),
      deadlineController.signal
    )
    const executionOutcome: Promise<OperationOutcome> = execution.then(
      result => {
        if (this.#exited) return { kind: 'ignored' }
        const parsed = engineCommandResultSchema.safeParse(result)
        if (
          !parsed.success ||
          !engineResultMatchesOperation(parsed.data, operation)
        ) {
          this.#fatalExit()
          return { kind: 'invalid' }
        }
        return { kind: 'result', result: parsed.data }
      },
      (error: unknown) => ({ kind: 'error', error })
    )
    let removeDeadlineListener = (): void => undefined
    const deadlineOutcome = new Promise<OperationOutcome>(resolve => {
      const onDeadline = (): void => resolve({ kind: 'timeout' })
      deadlineController.signal.addEventListener('abort', onDeadline, {
        once: true
      })
      removeDeadlineListener = () => {
        deadlineController.signal.removeEventListener('abort', onDeadline)
      }
    })

    void Promise.race([executionOutcome, deadlineOutcome])
      .then(outcome => {
        removeDeadlineListener()
        if (this.#exited || this.#shuttingDown) return
        const timedOut =
          outcome.kind === 'timeout' ||
          (outcome.kind === 'result' && this.#now() >= deadlineMs)
        if (outcome.kind === 'ignored' || outcome.kind === 'invalid') return
        if (outcome.kind === 'result' && !timedOut) {
          this.#postResult(message.requestId, outcome.result)
          return
        }
        const error = outcome.kind === 'error' ? outcome.error : undefined
        const aborted =
          error instanceof EngineOperationAbortedError ||
          error instanceof EngineQueueClosedError ||
          this.#queue.closed
        this.#postResult(
          message.requestId,
          operationError(
            operation,
            timedOut ? 'TIMEOUT' : aborted ? 'ABORTED' : 'INTERNAL',
            timedOut
              ? 'The torrent operation timed out.'
              : aborted
                ? 'The torrent operation was aborted.'
                : 'The torrent engine could not complete the operation.',
            timedOut
          )
        )
      })
      .finally(() => {
        clearTimeout(timeout)
      })
  }

  #shutdown(
    message: Extract<EngineParentMessage, { type: 'engine:shutdown' }>
  ): void {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    this.#queue.close()
    void this.#queue
      .drain()
      .then(() => this.#shutdownRuntime())
      .then(() => {
        if (this.#exited) return
        this.#postCorrelated({
          type: 'engine:stopped',
          requestId: message.requestId,
          payload: {}
        })
        if (this.#exited) return
        this.#exited = true
        this.#exit(0)
      })
      .catch(() => this.#fatalExit())
  }

  #postResult(requestId: string, payload: EngineCommandResult): void {
    this.#postCorrelated({
      type: 'engine:result',
      requestId,
      payload
    })
  }

  #postCorrelated(partial: CorrelatedChildPartial): boolean {
    return this.#post(partial)
  }

  #postEvent(event: EngineEvent, causeRequestId?: string): boolean {
    return this.#post({
      type: 'engine:event',
      eventId: randomUUID(),
      ...(causeRequestId ? { causeRequestId } : {}),
      payload: event
    })
  }

  #post(partial: CorrelatedChildPartial | EventChildPartial): boolean {
    if (!this.#generationId || this.#exited) return false

    const parsed = engineChildMessageSchema.safeParse({
      ...partial,
      protocolVersion: PROTOCOL_VERSION,
      generationId: this.#generationId,
      sequence: this.#outboundSequence,
      timestampMs: this.#now()
    })
    if (
      !parsed.success ||
      !checkPayloadBudget(parsed.data, ENGINE_MESSAGE_BUDGET).ok
    ) {
      this.#fatalExit()
      return false
    }

    try {
      this.#postMessage(parsed.data)
    } catch {
      this.#fatalExit()
      return false
    }
    this.#outboundSequence += 1
    return true
  }

  #fatalExit(): void {
    if (this.#exited) return
    this.#exited = true
    this.#queue.close()
    this.#exit(2)
  }

  #rememberRequestId(requestId: string): void {
    this.#recentRequestIds.add(requestId)
    if (this.#recentRequestIds.size <= MAX_RECENT_REQUEST_IDS) return
    const oldest = this.#recentRequestIds.values().next().value
    if (oldest) this.#recentRequestIds.delete(oldest)
  }
}
