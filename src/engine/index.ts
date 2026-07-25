import { randomBytes } from 'node:crypto'
import process from 'node:process'
import WebTorrent from 'webtorrent'
import type { EngineEvent, EngineRuntimeInfo } from '../shared/contracts'
import { EngineClientLifecycle } from './client-lifecycle'
import { DhtBoundary } from './dht-boundary'
import { resolve4 } from 'node:dns/promises'
import { LegacyImportService } from './legacy-import-service'
import { MediaProxy } from './media-proxy'
import { EgressPolicy } from './network-policy'
import { PeerAdmissionPolicy } from './peer-admission'
import { EngineProtocolController } from './protocol-controller'
import { EngineRuntime } from './runtime'
import { TorrentCreationService } from './torrent-creation'
import { TrackerActivation } from './tracker-activation'
import { TrackerHttpRequestGate, TrackerHttpTransport } from './tracker-http'
import { TorrentManager } from './torrent-manager'
import type { DiskTorrentSession } from './disk-torrent'
import type { TorrentOwner } from './torrent-registry'

const parentPort = process.parentPort
if (!parentPort) {
  throw new Error('The torrent engine must run as an Electron utility process')
}

const sessionSeed = randomBytes(16).toString('hex')
const egress = new EgressPolicy()
const trackerTransport = new TrackerHttpTransport({
  egress,
  requestGate: new TrackerHttpRequestGate()
})

const clients = new Map<'private' | 'public', WebTorrent>()

/**
 * A destroyed listener, connection pool, or client is engine-fatal. The engine
 * exits so main's supervisor performs its one clean restart and then contains
 * a repeated failure as a visible stopped state.
 */
let exiting = false
function failEngine(): void {
  if (exiting) return
  exiting = true
  setImmediate(() => process.exit(1))
}

const lifecycle = new EngineClientLifecycle({
  createClient: (owner, options) => {
    const client = new WebTorrent(options)
    clients.set(owner, client)
    return client
  },
  onFatal: () => {
    failEngine()
  }
})

function diskOwner(owner: TorrentOwner): 'private' | 'public' {
  return owner === 'private' ? 'private' : 'public'
}

/** Both clients must own a live listener before any torrent may be added. */
function resolveClient(owner: TorrentOwner): WebTorrent {
  const key = diskOwner(owner)
  lifecycle.handle(key)
  const client = clients.get(key)
  if (!client) throw new Error('CLIENT_UNAVAILABLE')
  return client
}

/**
 * One public-only DHT participant per engine. Its peers re-enter through the
 * same generation and address gate as every other discovery source.
 */
const dhtSessions = new Map<string, DiskTorrentSession>()
const dht = new DhtBoundary({
  onPeers: delivery => {
    const session = dhtSessions.get(delivery.infoHash)
    if (!session || session.generationId !== delivery.generationId) return
    for (const peer of delivery.peers) {
      session.admitPeer(`${peer.address}:${peer.port}`, 'dht')
    }
  },
  resolveBootstrap: async hostname => {
    try {
      return await resolve4(hostname)
    } catch {
      return []
    }
  }
})

const torrentManager = new TorrentManager({
  resolveClient,
  sessionOptions: {
    createActivation: session => {
      const tiers = session.metadata.announceTiers
      if (tiers.length === 0) return null

      const handle = lifecycle.handle(diskOwner(session.owner))
      const activation = new TrackerActivation({
        allowHttp: false,
        allowPrivateNetwork: false,
        infoHash: session.infoHash,
        onPeers: delivery => {
          for (const peer of delivery.peers) {
            session.admitPeer(`${peer.address}:${peer.port}`)
          }
        },
        peerId: handle.peerId,
        port: handle.port,
        private: session.metadata.private,
        progress: () => {
          const stats = session.stats()
          return {
            downloaded: stats.downloaded,
            left: Math.max(session.metadata.length - stats.downloaded, 0),
            uploaded: stats.uploaded
          }
        },
        sessionSeed,
        tiers,
        transport: trackerTransport
      })
      return {
        start: () => {
          activation.start()
          if (session.metadata.private) return
          dhtSessions.set(session.infoHash, session)
          void dht
            .activate({
              announcePort: handle.port,
              generationId: session.generationId,
              infoHash: session.infoHash,
              private: false
            })
            .catch(() => {
              // A DHT-scoped failure is a warning, never a torrent failure.
            })
        },
        stop: async () => {
          dhtSessions.delete(session.infoHash)
          dht.deactivate(session.infoHash)
          await activation.stop()
        }
      }
    },
    peerFilter: address => {
      const [host] = address.split(':')
      if (!host) return false
      const handle = lifecycle.handle('public')
      return new PeerAdmissionPolicy({
        allowPrivateNetwork: false,
        localPeerId: handle.peerId
      }).allows({ address: host })
    }
  }
})

/**
 * The initialize handshake creates both long-lived clients and proves the
 * packaged native WebRTC path before any command is accepted.
 */
async function startClients(): Promise<EngineRuntimeInfo> {
  if (
    process.type !== 'utility' ||
    process.arch !== 'arm64' ||
    process.versions.electron !== '43.2.0' ||
    process.versions.node !== '24.18.0'
  ) {
    throw new Error('RUNTIME_MISMATCH')
  }

  await lifecycle.start()
  await mediaProxy.start()
  const publicClient = clients.get('public')
  const privateClient = clients.get('private')
  if (
    !WebTorrent.WEBRTC_SUPPORT ||
    publicClient?.utp !== false ||
    privateClient?.utp !== false
  ) {
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
}

const mediaProxy = new MediaProxy()

let emitRuntimeEvent = (_event: EngineEvent): void => undefined
const runtime = new EngineRuntime({
  creationService: new TorrentCreationService({ policy: egress }),
  legacyImports: new LegacyImportService({ policy: egress }),
  mediaProxy,
  emitEvent: event => emitRuntimeEvent(event),
  torrentManager
})

const controller = new EngineProtocolController({
  execute: (operation, signal) => runtime.execute(operation, signal),
  exit: code => {
    setImmediate(() => process.exit(code))
  },
  postMessage: message => {
    parentPort.postMessage(message)
  },
  proveRuntime: startClients,
  // Torrents are destroyed with their stores intact before either client is
  // torn down, and cleanup continues through a failing phase.
  shutdown: async () => {
    try {
      await runtime.close()
    } finally {
      await mediaProxy.shutdown()
      dht.close()
      dhtSessions.clear()
      await lifecycle.close()
    }
  }
})
emitRuntimeEvent = event => {
  controller.emit(event)
}

parentPort.on('message', event => {
  controller.receive(event.data)
})
