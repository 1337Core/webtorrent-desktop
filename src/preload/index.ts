import { contextBridge, ipcRenderer } from 'electron'
import {
  bootstrapResultSchema,
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  ENGINE_STATUS_CHANNEL,
  engineStatusEventSchema,
  preloadTrustProofSchema,
  PROTOCOL_VERSION,
  restartEngineResultSchema,
  type BootstrapResult,
  type EngineStatusEvent,
  type EngineStatus,
  type RestartEngineResult
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'

const INVOKE_TIMEOUT_MS = 5_000
const RESULT_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const EVENT_BUDGET = {
  maxBytes: 16 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
let latestEngineStatusEvent: EngineStatusEvent | null = null
type ProtocolErrorResult = Extract<BootstrapResult, { ok: false }>

if (
  process.contextIsolated !== true ||
  process.sandboxed !== true ||
  process.isMainFrame !== true
) {
  throw new Error('Preload trust boundary verification failed')
}

const preloadTrustProof = preloadTrustProofSchema.parse({
  contextIsolated: process.contextIsolated,
  isMainFrame: process.isMainFrame,
  sandboxed: process.sandboxed
})

function protocolError(
  requestId: string,
  displayMessage: string
): ProtocolErrorResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: 'PROTOCOL_MISMATCH',
      retryable: false,
      displayMessage
    }
  }
}

async function invokeBounded(
  channel: string,
  request: unknown
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      ipcRenderer.invoke(channel, request),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('IPC request timed out')),
          INVOKE_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function getBootstrap(): Promise<BootstrapResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_BOOTSTRAP_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'bootstrap',
      payload: { preloadTrustProof }
    })
    if (!checkPayloadBudget(value, RESULT_BUDGET).ok) {
      return protocolError(
        requestId,
        'The bootstrap response exceeded its fixed size limit.'
      )
    }

    const result = bootstrapResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid bootstrap response.'
      )
    }
    if (
      result.data.ok &&
      latestEngineStatusEvent &&
      latestEngineStatusEvent.sequence >
        result.data.value.engineStatusEvent.sequence
    ) {
      return bootstrapResultSchema.parse({
        ...result.data,
        value: {
          ...result.data.value,
          engineStatusEvent: latestEngineStatusEvent
        }
      })
    }
    return result.data
  } catch {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        retryable: true,
        displayMessage: 'The application did not answer the bootstrap request.'
      }
    }
  }
}

async function restartEngine(): Promise<RestartEngineResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_ENGINE_RESTART_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'restartEngine',
      payload: {}
    })
    if (!checkPayloadBudget(value, RESULT_BUDGET).ok) {
      return protocolError(
        requestId,
        'The engine restart response exceeded its fixed size limit.'
      )
    }

    const result = restartEngineResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid engine restart response.'
      )
    }
    return result.data
  } catch {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        retryable: true,
        displayMessage:
          'The application did not answer the engine restart request.'
      }
    }
  }
}

function onEngineStatus(listener: (status: EngineStatus) => void): () => void {
  let active = true
  let lastSequence = -1
  const wrappedListener = (
    _event: Electron.IpcRendererEvent,
    value: unknown
  ): void => {
    if (!active || !checkPayloadBudget(value, EVENT_BUDGET).ok) return

    const parsed = engineStatusEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.sequence <= lastSequence) return
    lastSequence = parsed.data.sequence
    if (
      !latestEngineStatusEvent ||
      parsed.data.sequence > latestEngineStatusEvent.sequence
    ) {
      latestEngineStatusEvent = parsed.data
    }
    listener(parsed.data.status)
  }

  ipcRenderer.on(ENGINE_STATUS_CHANNEL, wrappedListener)
  return () => {
    if (!active) return
    active = false
    ipcRenderer.removeListener(ENGINE_STATUS_CHANNEL, wrappedListener)
  }
}

contextBridge.exposeInMainWorld(
  'desktop',
  Object.freeze({
    getBootstrap,
    restartEngine,
    onEngineStatus
  })
)
