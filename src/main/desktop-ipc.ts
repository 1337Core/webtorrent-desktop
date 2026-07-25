import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  bootstrapRequestSchema,
  bootstrapResultSchema,
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  DESKTOP_TORRENT_COMMAND_CHANNEL,
  PROTOCOL_VERSION,
  restartEngineRequestSchema,
  restartEngineResultSchema,
  torrentCommandRequestSchema,
  torrentCommandResultSchema,
  type BootstrapResult,
  type EngineStatusEvent,
  type PreloadTrustProof,
  type RestartEngineResult,
  type RuntimeInfo
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'
import type { Diagnostics } from './diagnostics'
import type { EngineSupervisor } from './engine-supervisor'
import type { AppStateStore } from './state-store'
import { isTrustedRendererEvent } from './trusted-renderer'

const REQUEST_BUDGET = {
  maxBytes: 4 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const RESULT_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const MAX_RECENT_REQUESTS = 256

type DesktopIpcOptions = {
  diagnostics: Diagnostics
  engineSupervisor: EngineSupervisor
  getEngineStatusEvent: () => EngineStatusEvent
  onBootstrap: (trustProof: PreloadTrustProof) => void
  runtime: RuntimeInfo
  stateStore: AppStateStore
  window: BrowserWindow
}

function candidateRequestId(value: unknown): string | null {
  if (
    value &&
    typeof value === 'object' &&
    'requestId' in value &&
    typeof value.requestId === 'string'
  ) {
    const parsed = z.string().uuid().safeParse(value.requestId)
    return parsed.success ? parsed.data : null
  }
  return null
}

function errorResult(
  requestId: string | null,
  code:
    | 'DUPLICATE_REQUEST'
    | 'ENGINE_UNAVAILABLE'
    | 'INTERNAL'
    | 'INVALID_REQUEST'
    | 'PAYLOAD_TOO_LARGE'
    | 'UNAUTHORIZED_SENDER',
  displayMessage: string,
  retryable: boolean
): BootstrapResult | RestartEngineResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      retryable,
      displayMessage
    }
  }
}

export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const {
    diagnostics,
    engineSupervisor,
    getEngineStatusEvent,
    onBootstrap,
    runtime,
    stateStore,
    window
  } = options
  const frameIpc = window.webContents.mainFrame.ipc
  const recentRequests = new Set<string>()
  const requestOrder: string[] = []

  function authorize(
    event: IpcMainInvokeEvent,
    value: unknown
  ): BootstrapResult | RestartEngineResult | null {
    if (!isTrustedRendererEvent(event, window)) {
      diagnostics.warn('ipc.unauthorized')
      return errorResult(
        null,
        'UNAUTHORIZED_SENDER',
        'The application rejected an unauthorized request.',
        false
      )
    }

    if (!checkPayloadBudget(value, REQUEST_BUDGET).ok) {
      diagnostics.warn('ipc.request-over-budget')
      return errorResult(
        candidateRequestId(value),
        'PAYLOAD_TOO_LARGE',
        'The application request exceeded its fixed size limit.',
        false
      )
    }

    return null
  }

  function rememberRequest(
    requestId: string
  ): BootstrapResult | RestartEngineResult | null {
    if (recentRequests.has(requestId)) {
      return errorResult(
        requestId,
        'DUPLICATE_REQUEST',
        'The application rejected a duplicate request.',
        false
      )
    }

    recentRequests.add(requestId)
    requestOrder.push(requestId)
    if (requestOrder.length > MAX_RECENT_REQUESTS) {
      const oldest = requestOrder.shift()
      if (oldest) recentRequests.delete(oldest)
    }
    return null
  }

  frameIpc.handle(DESKTOP_BOOTSTRAP_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return bootstrapResultSchema.parse(rejected)

    const request = bootstrapRequestSchema.safeParse(value)
    if (!request.success) {
      return bootstrapResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received an invalid bootstrap request.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return bootstrapResultSchema.parse(duplicate)

    try {
      const state = stateStore.snapshot()
      const result: BootstrapResult = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          engineStatusEvent: getEngineStatusEvent(),
          state: {
            schemaVersion: state.schemaVersion,
            revision: state.revision,
            preferences: state.preferences
          },
          runtime
        }
      }
      if (!checkPayloadBudget(result, RESULT_BUDGET).ok) {
        throw new Error('Bootstrap result exceeded its fixed payload budget')
      }
      const parsedResult = bootstrapResultSchema.parse(result)
      onBootstrap(request.data.payload.preloadTrustProof)
      return parsedResult
    } catch {
      diagnostics.error('ipc.bootstrap-failed')
      return bootstrapResultSchema.parse(
        errorResult(
          request.data.requestId,
          'INTERNAL',
          'The application could not prepare its initial state.',
          true
        )
      )
    }
  })

  frameIpc.handle(DESKTOP_ENGINE_RESTART_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return restartEngineResultSchema.parse(rejected)

    const request = restartEngineRequestSchema.safeParse(value)
    if (!request.success) {
      return restartEngineResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received an invalid engine restart request.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return restartEngineResultSchema.parse(duplicate)

    if (!engineSupervisor.restart()) {
      return restartEngineResultSchema.parse(
        errorResult(
          request.data.requestId,
          'ENGINE_UNAVAILABLE',
          'The torrent engine is not in a restartable state.',
          true
        )
      )
    }

    return restartEngineResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.data.requestId,
      ok: true,
      value: {
        accepted: true,
        status: engineSupervisor.status()
      }
    })
  })

  /**
   * Torrent commands cross one validated channel. Main never forwards an
   * arbitrary payload: the operation is parsed against the engine contract
   * here, and the engine result is parsed again before it reaches the
   * renderer.
   */
  frameIpc.handle(
    DESKTOP_TORRENT_COMMAND_CHANNEL,
    async (event, value: unknown) => {
      const rejected = authorize(event, value)
      if (rejected) return torrentCommandResultSchema.parse(rejected)

      const request = torrentCommandRequestSchema.safeParse(value)
      if (!request.success) {
        return torrentCommandResultSchema.parse(
          errorResult(
            candidateRequestId(value),
            'INVALID_REQUEST',
            'The application received an invalid torrent command.',
            false
          )
        )
      }

      const duplicate = rememberRequest(request.data.requestId)
      if (duplicate) return torrentCommandResultSchema.parse(duplicate)

      const result = await engineSupervisor.execute(
        request.data.payload.operation
      )
      return torrentCommandResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: result
      })
    }
  )

  return () => {
    frameIpc.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL)
    frameIpc.removeHandler(DESKTOP_ENGINE_RESTART_CHANNEL)
    frameIpc.removeHandler(DESKTOP_TORRENT_COMMAND_CHANNEL)
  }
}
