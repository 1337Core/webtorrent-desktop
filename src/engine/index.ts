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
import { StagingTrackerChain } from './staging-tracker-chain'
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
import { bindTrackedPeerLifecycle } from './webtorrent-peer-adapter'
import { proveAudioMetadataRuntime } from './audio-metadata'

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
const stagingDhtSessions = new Map<
  string,
  Readonly<{
    admitPeer: (address: string) => boolean
    generationId: string
  }>
>()
const pendingCommittedDht = new Map<
  string,
  Readonly<{ port: number; session: DiskTorrentSession }>
>()
const dht = new DhtBoundary({
  onPeers: delivery => {
    const session = dhtSessions.get(delivery.infoHash)
    if (session?.generationId === delivery.generationId) {
      for (const peer of delivery.peers) {
        session.admitPeer(`${peer.address}:${peer.port}`, 'dht')
      }
      return
    }
    const staging = stagingDhtSessions.get(delivery.infoHash)
    if (staging?.generationId !== delivery.generationId) return
    for (const peer of delivery.peers) {
      staging.admitPeer(`${peer.address}:${peer.port}`)
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

function activateCommittedDht(session: DiskTorrentSession, port: number): void {
  dhtSessions.set(session.infoHash, session)
  if (stagingDhtSessions.has(session.infoHash)) {
    pendingCommittedDht.set(session.infoHash, { port, session })
    return
  }
  const pending = pendingCommittedDht.get(session.infoHash)
  if (pending?.session === session) {
    pendingCommittedDht.delete(session.infoHash)
  }
  void dht
    .activate({
      announcePort: port,
      generationId: session.generationId,
      infoHash: session.infoHash,
      private: false
    })
    .then(() => undefined)
    .catch(() => {
      // A DHT-scoped network failure is a warning, never a torrent failure.
    })
}

function retryCommittedDht(infoHash: string): void {
  const pending = pendingCommittedDht.get(infoHash)
  if (!pending || dhtSessions.get(infoHash) !== pending.session) return
  pendingCommittedDht.delete(infoHash)
  activateCommittedDht(pending.session, pending.port)
}

function deactivateCommittedDht(session: DiskTorrentSession): void {
  if (dhtSessions.get(session.infoHash) === session) {
    dhtSessions.delete(session.infoHash)
  }
  const pending = pendingCommittedDht.get(session.infoHash)
  if (pending?.session === session) pendingCommittedDht.delete(session.infoHash)
  dht.deactivate(session.infoHash, session.generationId)
}

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
const liveStagingClients = new Set<WebTorrent>()

function stagingLiveTransports(): number {
  let total = 0
  for (const client of liveStagingClients) {
    if (client.destroyed) {
      liveStagingClients.delete(client)
      continue
    }
    total += client.torrents.reduce(
      (subtotal, torrent) => subtotal + torrent.numPeers,
      0
    )
  }
  return total
}

const peerBudget = new PeerBudget({
  liveTransports: () => torrentManager.liveTransports + stagingLiveTransports(),
  stagingLiveTransports
})

const trackerActivations = new WeakMap<DiskTorrentSession, TrackerActivation>()

const torrentManager: TorrentManager = new TorrentManager({
  resolveClient,
  resume: resumeStore,
  sessionOptions: {
    budget: peerBudget,
    // The tracker activation currently serving each session, so a completion
    // transition can reach the announce that has to report it.
    createActivation: session => {
      const tiers = session.metadata.announceTiers

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
        // A private torrent's WSS endpoints form one serial chain, exactly as
        // its HTTP endpoints do. Without this a private torrent announced to
        // several WSS trackers at once while the HTTP side was contacting one.
        private: session.metadata.private,
        progress: () => {
          const stats = session.stats()
          return {
            downloaded: stats.downloaded,
            left: Math.max(session.metadata.length - stats.downloaded, 0),
            uploaded: stats.uploaded
          }
        },
        serialRetirement: session.metadata.private,
        tiers
      })

      trackerActivations.set(session, activation)
      return {
        start: () => {
          activation.start()
          void wss.start().catch(() => {
            // A WSS-scoped failure is a warning, never a torrent failure.
          })
          if (session.metadata.private) return
          activateCommittedDht(session, handle.port)
        },
        stop: async () => {
          deactivateCommittedDht(session)
          signaling.close()
          if (trackerActivations.get(session) === activation) {
            trackerActivations.delete(session)
          }
          await Promise.all([activation.stop(), wss.stop()])
        }
      }
    },
    onCompleted: session => {
      trackerActivations.get(session)?.notifyCompleted()
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

  const audioMetadataParser = await proveAudioMetadataRuntime()
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
    audioMetadataParser,
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
 * hash. Every acquisition gets a disposable client and identity, with at most
 * two alive concurrently, and destroys it as soon as that acquisition ends.
 */
const stagingClients = new StagingClientPool({
  closeInbound: async client => {
    const connectionPool = (
      client as unknown as {
        _connPool?: {
          _pendingConns?: Set<{
            destroy(): void
            on?(event: string, listener: () => void): unknown
          }>
          tcpServer?: {
            closeAllConnections?(): void
            close(callback: (error?: Error) => void): void
            removeAllListeners(event: string): void
          }
        }
      }
    )._connPool
    const server = connectionPool?.tcpServer
    if (!server || !connectionPool) {
      throw new Error('STAGING_INBOUND_GUARD_UNAVAILABLE')
    }
    // Stop admission before beginning asynchronous listener close, then tear
    // down every socket accepted during WebTorrent's startup window.
    server.removeAllListeners('connection')
    for (const socket of connectionPool._pendingConns ?? []) {
      try {
        socket.on?.('error', () => undefined)
        socket.destroy()
      } catch {
        // Continue closing every pending accepted socket.
      }
    }
    connectionPool._pendingConns?.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      try {
        server.close(error => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error('CLOSE_FAILED'))
      }
    })
  },
  createClient: options => {
    const client = new WebTorrent(options)
    liveStagingClients.add(client)
    return client as never
  },
  onUnhealthy: () => failEngine()
})

const metadataAcquisition = new MetadataAcquisition({
  /**
   * A staging acquisition discovers peers exactly as an owned torrent does:
   * through the app's mediated tracker transport, under the staging client's
   * own identity, and never through WebTorrent's disabled tracker client.
   */
  discover: ({
    admitPeer,
    allowDht,
    infoHash,
    peerId,
    port,
    removePeer,
    retirePeers,
    trackers
  }) => {
    const generationId = `staging-${randomBytes(16).toString('hex')}`
    const budgetKey = `${generationId}:${infoHash}`
    let frozen = false
    const admitBoundedPeer = (peer: unknown, identity: string): boolean => {
      if (frozen) return false
      const newRecord = !peerBudget.has(budgetKey, identity)
      if (
        !peerBudget.admit({
          key: budgetKey,
          peer: identity,
          remove: () => removePeer(peer),
          scope: 'staging'
        })
      ) {
        return false
      }
      const transport = peerBudget.reserveTransport({
        key: budgetKey,
        peer: identity,
        scope: 'staging'
      })
      if (!transport) {
        if (newRecord) peerBudget.forget(budgetKey, identity)
        return false
      }
      let result: unknown
      try {
        result = admitPeer(peer)
      } catch {
        result = false
      }
      if (
        bindTrackedPeerLifecycle(result, {
          counted: transport.release,
          rejected: transport.release,
          retired: () => peerBudget.forget(budgetKey, identity)
        })
      ) {
        return true
      }
      if (newRecord) peerBudget.forget(budgetKey, identity)
      return false
    }
    const trackerChain =
      trackers.length === 0
        ? null
        : new StagingTrackerChain({
            endpoints: trackers,
            createAttempt: endpoint => {
              let activate = (): void => undefined
              let fail = (): void => undefined
              const activated = new Promise<void>(resolve => {
                activate = resolve
              })
              const failed = new Promise<void>(resolve => {
                fail = resolve
              })

              if (new URL(endpoint).protocol === 'https:') {
                const activation = new TrackerActivation({
                  allowHttp: false,
                  allowPrivateNetwork: false,
                  infoHash,
                  onActivated: activate,
                  onExhausted: fail,
                  onPeers: delivery => {
                    for (const peer of delivery.peers) {
                      const address = `${peer.address}:${peer.port}`
                      admitBoundedPeer(address, address)
                    }
                  },
                  onRetireGeneration: () => {
                    retirePeers()
                    peerBudget.release(budgetKey)
                  },
                  peerId,
                  port,
                  private: true,
                  progress: () => ({
                    downloaded: 0,
                    left: 16_384,
                    uploaded: 0
                  }),
                  sessionSeed,
                  singlePass: true,
                  tiers: [[endpoint]],
                  transport: trackerTransport
                })
                return {
                  activated,
                  failed,
                  freeze: () => activation.freeze(),
                  start: () => activation.start(),
                  stop: () => activation.stop()
                }
              }

              const signaling = new WebrtcSignaling({
                createPeer: ({ initiator }) => createSignalingPeer(initiator),
                handoff: (peer, remotePeerId) => {
                  const remoteAddress = (
                    peer as SignalingPeer & { remoteAddress?: unknown }
                  ).remoteAddress
                  if (typeof remoteAddress !== 'string') return false
                  if (
                    !new PeerAdmissionPolicy({
                      allowPrivateNetwork: false,
                      localPeerId: peerId
                    }).allows({ address: remoteAddress })
                  ) {
                    return false
                  }
                  return admitBoundedPeer(peer, remotePeerId)
                },
                isSelfPeerId: remotePeerId =>
                  remotePeerId === peerIdentity(peerId),
                pending: pendingSignaling
              })
              const wss = new WssActivation({
                allowPrivateNetwork: false,
                connectSocket: input => wssSockets.connect(input),
                createOffers: (count, trackerUrl) =>
                  signaling.createOffers(count, trackerUrl),
                infoHash,
                onActivated: activate,
                onAnswer: answer => signaling.acceptAnswer(answer),
                onExhausted: fail,
                onOffer: (offer, trackerUrl, respond) => {
                  signaling.acceptOffer(offer, trackerUrl, respond)
                },
                onRetireEndpoint: trackerUrl => {
                  signaling.retireEndpoint(trackerUrl)
                  retirePeers()
                  peerBudget.release(budgetKey)
                },
                peerId: peerIdentity(peerId),
                progress: () => ({
                  downloaded: 0,
                  left: 16_384,
                  uploaded: 0
                }),
                serialRetirement: true,
                tiers: [[endpoint]]
              })
              let earlyStop: Promise<void> | null = null
              return {
                activated,
                failed,
                freeze: () => {
                  signaling.close()
                  earlyStop ??= wss.stop()
                },
                start: () => {
                  void wss.start().catch(() => fail())
                },
                stop: async () => {
                  signaling.close()
                  await Promise.all([earlyStop, wss.stop()])
                }
              }
            }
          })
    trackerChain?.start()

    let dhtReady = Promise.resolve()
    if (allowDht) {
      // DHT activations are keyed by info hash. Never replace a live torrent
      // or another staging generation with a duplicate acquisition.
      if (dhtSessions.has(infoHash) || stagingDhtSessions.has(infoHash)) {
        dhtReady = Promise.reject(new Error('DHT_ACTIVATION_CONFLICT'))
      } else {
        stagingDhtSessions.set(infoHash, {
          admitPeer: address => admitBoundedPeer(address, address),
          generationId
        })
        // Port zero makes this a lookup-only staging cycle. Unlike a committed
        // public torrent, metadata staging never announces its listener.
        dhtReady = dht
          .activate({
            announcePort: 0,
            generationId,
            infoHash,
            private: false
          })
          .catch(error => {
            const current = stagingDhtSessions.get(infoHash)
            if (current?.generationId === generationId) {
              stagingDhtSessions.delete(infoHash)
            }
            dht.deactivate(infoHash, generationId)
            retryCommittedDht(infoHash)
            throw error
          })
      }
    }

    let stopped = false
    const freeze = (): void => {
      if (frozen) return
      frozen = true
      trackerChain?.freeze()
      const current = stagingDhtSessions.get(infoHash)
      if (current?.generationId === generationId) {
        stagingDhtSessions.delete(infoHash)
        dht.deactivate(infoHash, generationId)
        retryCommittedDht(infoHash)
      }
      retirePeers()
      peerBudget.release(budgetKey)
    }
    return {
      freeze,
      ready: Promise.all([
        trackerChain?.ready ?? Promise.resolve(),
        dhtReady
      ]).then(() => undefined),
      stop: async () => {
        if (stopped) return
        stopped = true
        freeze()
        await Promise.allSettled([trackerChain?.ready, dhtReady])
        await trackerChain?.stop()
      }
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
  onUnhealthy: () => failEngine()
  // Acquisition runs behind `start-acquisition`, not inside one bounded
  // request, so it keeps its own full budget.
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
      stagingDhtSessions.clear()
      await mediaProxy.shutdown()
      dht.close()
      dhtSessions.clear()
      pendingCommittedDht.clear()
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
