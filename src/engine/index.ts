import { randomBytes } from 'node:crypto'
import path from 'node:path'
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
import { ResumeStore } from './resume-store'
import { TorrentArchive } from './torrent-archive'
import { TorrentCreationService } from './torrent-creation'
import { validateTorrentMetadata } from './torrent-metadata'
import { TrackerActivation } from './tracker-activation'
import { TrackerHttpRequestGate, TrackerHttpTransport } from './tracker-http'
import { PeerBudget } from './peer-budget'
import { TorrentManager } from './torrent-manager'
import { MetadataAcquisition } from './metadata-acquisition'
import { StagingClientPool } from './staging-client'
import { TorrentPreparationService } from './torrent-preparation-service'
import {
  PendingSignalingBudget,
  WebrtcSignaling,
  type SignalingPeer
} from './webrtc-signaling'
import { WssActivation } from './wss-activation'
import { WssSocketFactory } from './wss-socket'
import SimplePeer from '@thaunknown/simple-peer'
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

const wssSockets = new WssSocketFactory({ policy: egress })
const pendingSignaling = new PendingSignalingBudget()

/**
 * The engine's fixed WebRTC configuration. No tracker message contributes to
 * it: there is no ICE server, no trickle, and one bounded ICE completion.
 */
const RTC_CONFIGURATION = Object.freeze({
  iceServers: [] as ReadonlyArray<never>,
  sdpSemantics: 'unified-plan'
})

function createSignalingPeer(initiator: boolean): SignalingPeer {
  return new SimplePeer({
    config: { ...RTC_CONFIGURATION },
    iceCompleteTimeout: 5_000,
    initiator,
    trickle: false
  }) as unknown as SignalingPeer
}

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

/** Tracker signaling carries the twenty raw peer-ID bytes as a JSON string. */
function peerIdentity(peerId: Uint8Array): string {
  return Buffer.from(peerId).toString('latin1')
}

/** The current peer identity of a live client, or null while it has none. */
function localPeerIdentity(owner: 'private' | 'public'): string | null {
  try {
    return peerIdentity(lifecycle.handle(owner).peerId)
  } catch {
    return null
  }
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

// Main gives the engine a 0700 fork-owned working directory as its cwd; the
// resume sidecars and archived torrent bytes live under it and nowhere else.
const forkDirectory = path.resolve(process.cwd())
const resumeStore = new ResumeStore({
  directory: path.join(forkDirectory, 'resume')
})
const torrentArchive = new TorrentArchive({
  directory: path.join(forkDirectory, 'torrents')
})

/**
 * One shared admission budget for the whole engine. WebTorrent bounds
 * connections per torrent, so without this a single busy torrent could hold
 * every peer slot across both clients.
 */
const peerBudget = new PeerBudget({
  liveTransports: () => torrentManager.liveTransports
})

const torrentManager: TorrentManager = new TorrentManager({
  resolveClient,
  resume: resumeStore,
  sessionOptions: {
    budget: peerBudget,
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
      const signaling = new WebrtcSignaling({
        createPeer: ({ initiator }) => createSignalingPeer(initiator),
        handoff: peer => session.admitConnection(peer),
        // A peer identity belonging to either client is this engine itself.
        isSelfPeerId: peerId =>
          peerId === localPeerIdentity('public') ||
          peerId === localPeerIdentity('private'),
        pending: pendingSignaling
      })
      const wss = new WssActivation({
        allowPrivateNetwork: false,
        connectSocket: input => wssSockets.connect(input),
        createOffers: (count, trackerUrl) =>
          signaling.createOffers(count, trackerUrl),
        infoHash: session.infoHash,
        onAnswer: answer => {
          signaling.acceptAnswer(answer)
        },
        onOffer: (offer, trackerUrl, respond) => {
          signaling.acceptOffer(offer, trackerUrl, respond)
        },
        peerId: peerIdentity(handle.peerId),
        progress: () => {
          const stats = session.stats()
          return {
            downloaded: stats.downloaded,
            left: Math.max(session.metadata.length - stats.downloaded, 0),
            uploaded: stats.uploaded
          }
        },
        tiers
      })

      return {
        start: () => {
          activation.start()
          void wss.start().catch(() => {
            // A WSS-scoped failure is a warning, never a torrent failure.
          })
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
          signaling.close()
          await Promise.all([activation.stop(), wss.stop()])
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
  const mediaPort = await mediaProxy.start()
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
    mediaPort,
    electronVersion: '43.2.0',
    nodeVersion: '24.18.0',
    processType: 'utility',
    utpEnabled: false,
    webRtcSupported: true,
    webTorrentVersion: '3.0.16'
  }
}

/**
 * Staging exists only while metadata is being acquired for a magnet or info
 * hash. The client is spawned on demand, shared by at most two concurrent
 * acquisitions, and destroyed as soon as the last one finishes.
 */
const stagingClients = new StagingClientPool({
  createClient: options => new WebTorrent(options) as never
})

const metadataAcquisition = new MetadataAcquisition({
  /**
   * A staging acquisition discovers peers exactly as an owned torrent does:
   * through the app's mediated tracker transport, under the staging client's
   * own identity, and never through WebTorrent's disabled tracker client.
   */
  discover: async ({ admitPeer, infoHash, peerId, port, trackers }) => {
    const activation = new TrackerActivation({
      allowHttp: false,
      allowPrivateNetwork: false,
      infoHash,
      onPeers: delivery => {
        for (const peer of delivery.peers) {
          admitPeer(`${peer.address}:${peer.port}`)
        }
      },
      peerId,
      port,
      private: false,
      progress: () => ({ downloaded: 0, left: 0, uploaded: 0 }),
      sessionSeed,
      tiers: trackers.map(tracker => [tracker]),
      transport: trackerTransport
    })
    activation.start()
    return async () => {
      await activation.stop()
    }
  },
  openStaging: async () => {
    const lease = await stagingClients.lease()
    return {
      client: lease.client as never,
      peerId: lease.peerId,
      port: lease.port,
      release: lease.release
    }
  },
  // Acquisition runs behind `start-acquisition`, not inside one bounded
  // request, so it keeps its own full budget.
  stagingPath: path.join(forkDirectory, 'staging')
})

const mediaProxy = new MediaProxy()

let emitRuntimeEvent = (_event: EngineEvent): void => undefined
const runtime = new EngineRuntime({
  createPreparationService: store =>
    new TorrentPreparationService({
      acquireMetadata: (prepared, signal) =>
        metadataAcquisition.acquire(prepared, signal),
      store
    }),
  creationService: new TorrentCreationService({ policy: egress }),
  legacyImports: new LegacyImportService({ policy: egress }),
  mediaProxy,
  emitEvent: event => emitRuntimeEvent(event),
  resumeSelection: async infoHash =>
    (await resumeStore.load(infoHash))?.selectedPaths ?? null,
  torrentArchive,
  torrentManager,
  validateArchivedMetadata: bytes => validateTorrentMetadata(bytes, egress)
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
      metadataAcquisition.close()
      await stagingClients.close()
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
