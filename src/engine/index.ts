import process from 'node:process'
import WebTorrent from 'webtorrent'
import {
  engineChildMessageSchema,
  engineParentMessageSchema,
  PROTOCOL_VERSION,
  type EngineChildMessage,
  type EngineParentMessage,
  type EngineRuntimeInfo
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'

const ENGINE_MESSAGE_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}

const parentPort = process.parentPort
if (!parentPort) {
  throw new Error('The torrent engine must run as an Electron utility process')
}

let generationId: string | null = null
let inboundSequence = -1
let outboundSequence = 0
let initialized = false
let operationQueue = Promise.resolve()

function post(
  partial:
    | Pick<
        Extract<EngineChildMessage, { type: 'engine:ready' }>,
        'type' | 'requestId' | 'payload'
      >
    | Pick<
        Extract<EngineChildMessage, { type: 'engine:pong' }>,
        'type' | 'requestId' | 'payload'
      >
    | Pick<
        Extract<EngineChildMessage, { type: 'engine:stopped' }>,
        'type' | 'requestId' | 'payload'
      >
    | Pick<
        Extract<EngineChildMessage, { type: 'engine:failed' }>,
        'type' | 'requestId' | 'payload'
      >
): void {
  if (!generationId) {
    process.exitCode = 2
    return
  }

  const message = engineChildMessageSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    generationId,
    requestId: partial.requestId,
    sequence: outboundSequence,
    timestampMs: Date.now(),
    type: partial.type,
    payload: partial.payload
  })
  if (!checkPayloadBudget(message, ENGINE_MESSAGE_BUDGET).ok) {
    process.exitCode = 2
    return
  }

  outboundSequence += 1
  parentPort.postMessage(message)
}

async function proveNativeWebRtc(): Promise<EngineRuntimeInfo> {
  if (
    process.type !== 'utility' ||
    process.arch !== 'arm64' ||
    process.versions.electron !== '43.2.0' ||
    process.versions.node !== '24.18.0'
  ) {
    throw new Error('RUNTIME_MISMATCH')
  }

  const client = new WebTorrent({
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    utp: false
  })

  try {
    if (!WebTorrent.WEBRTC_SUPPORT || client.utp !== false) {
      throw new Error('NATIVE_WEBRTC_UNAVAILABLE')
    }

    return {
      architecture: 'arm64',
      electronVersion: '43.2.0',
      nodeVersion: '24.18.0',
      processType: 'utility',
      utpEnabled: false,
      webRtcSupported: true,
      webTorrentVersion: '3.0.16'
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      client.destroy(error => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

async function handleMessage(message: EngineParentMessage): Promise<void> {
  switch (message.type) {
    case 'engine:initialize': {
      if (initialized) {
        post({
          type: 'engine:failed',
          requestId: message.requestId,
          payload: {
            code: 'INVALID_MESSAGE',
            message: 'Torrent engine was initialized more than once.'
          }
        })
        return
      }

      generationId = message.generationId
      try {
        const runtime = await proveNativeWebRtc()
        initialized = true
        post({
          type: 'engine:ready',
          requestId: message.requestId,
          payload: runtime
        })
      } catch (error) {
        const code =
          error instanceof Error &&
          error.message === 'NATIVE_WEBRTC_UNAVAILABLE'
            ? 'NATIVE_WEBRTC_UNAVAILABLE'
            : error instanceof Error && error.message === 'RUNTIME_MISMATCH'
              ? 'RUNTIME_MISMATCH'
              : 'START_FAILED'
        post({
          type: 'engine:failed',
          requestId: message.requestId,
          payload: {
            code,
            message: 'Torrent engine failed its startup capability check.'
          }
        })
      }
      break
    }
    case 'engine:ping':
      if (!initialized) {
        post({
          type: 'engine:failed',
          requestId: message.requestId,
          payload: {
            code: 'INVALID_MESSAGE',
            message: 'Torrent engine received a ping before initialization.'
          }
        })
        return
      }
      post({
        type: 'engine:pong',
        requestId: message.requestId,
        payload: {}
      })
      break
    case 'engine:shutdown':
      post({
        type: 'engine:stopped',
        requestId: message.requestId,
        payload: {}
      })
      setImmediate(() => process.exit(0))
      break
  }
}

parentPort.on('message', event => {
  const value: unknown = event.data
  if (!checkPayloadBudget(value, ENGINE_MESSAGE_BUDGET).ok) {
    process.exit(2)
  }

  const parsed = engineParentMessageSchema.safeParse(value)
  if (
    !parsed.success ||
    (generationId !== null && parsed.data.generationId !== generationId) ||
    parsed.data.sequence <= inboundSequence
  ) {
    process.exit(2)
  }
  if (generationId === null) {
    if (parsed.data.type !== 'engine:initialize') process.exit(2)
    generationId = parsed.data.generationId
  }

  inboundSequence = parsed.data.sequence
  operationQueue = operationQueue
    .then(() => handleMessage(parsed.data))
    .catch(() => {
      process.exit(2)
    })
})
