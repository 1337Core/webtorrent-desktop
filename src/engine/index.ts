import process from 'node:process'
import WebTorrent from 'webtorrent'
import type { EngineStatus } from '../shared/contracts'

function report(status: EngineStatus): void {
  if (!process.parentPort) {
    throw new Error(
      'The torrent engine must run as an Electron utility process'
    )
  }

  process.parentPort.postMessage(status)
}

async function proveNativeWebRtc(): Promise<void> {
  if (process.type !== 'utility') {
    throw new Error(`Expected utility process, received ${process.type}`)
  }
  if (process.arch !== 'arm64') {
    throw new Error(`Expected arm64 engine, received ${process.arch}`)
  }
  if (process.versions.electron !== '43.2.0') {
    throw new Error(
      `Expected Electron 43.2.0, received ${process.versions.electron}`
    )
  }
  if (process.versions.node !== '24.18.0') {
    throw new Error(`Expected Node 24.18.0, received ${process.versions.node}`)
  }

  const client = new WebTorrent({
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    utp: false
  })

  const webRtcSupported = Boolean(WebTorrent.WEBRTC_SUPPORT)
  if (!webRtcSupported) {
    throw new Error('WebTorrent loaded without native WebRTC support')
  }
  if (client.utp !== false) {
    throw new Error('WebTorrent initialized with uTP enabled')
  }

  report({
    state: 'ready',
    architecture: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    processType: process.type,
    utpEnabled: client.utp,
    webRtcSupported,
    webTorrentVersion: WebTorrent.VERSION ?? '3.0.16'
  })

  await new Promise<void>((resolve, reject) => {
    client.destroy(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

proveNativeWebRtc().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unknown engine error'
  report({ state: 'failed', message })
  process.exitCode = 1
})
