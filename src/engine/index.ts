import process from 'node:process'
import WebTorrent from 'webtorrent'
import type {
  EngineCommand,
  EngineCommandResult,
  EngineRuntimeInfo
} from '../shared/contracts'
import { createClientOptions } from './client-config'
import { EngineProtocolController } from './protocol-controller'

const parentPort = process.parentPort
if (!parentPort) {
  throw new Error('The torrent engine must run as an Electron utility process')
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

  const client = new WebTorrent(createClientOptions('staging'))

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

function executeOperation(
  operation: EngineCommand,
  _signal: AbortSignal
): Promise<EngineCommandResult> {
  if (operation.command === 'list-torrents') {
    return Promise.resolve({
      ok: true,
      result: {
        command: 'list-torrents',
        value: {
          items: [],
          nextCursor: null,
          total: 0
        }
      }
    })
  }

  return Promise.resolve({
    ok: false,
    error: {
      command: operation.command,
      code: 'UNSUPPORTED',
      displayMessage: 'This torrent operation is not available yet.',
      retryable: false
    }
  })
}

const controller = new EngineProtocolController({
  execute: executeOperation,
  exit: code => {
    setImmediate(() => process.exit(code))
  },
  postMessage: message => {
    parentPort.postMessage(message)
  },
  proveRuntime: proveNativeWebRtc
})

parentPort.on('message', event => {
  controller.receive(event.data)
})
