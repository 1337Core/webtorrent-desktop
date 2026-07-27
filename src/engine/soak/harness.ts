import { randomBytes } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import createTorrent from 'create-torrent'
import SimplePeer from '@thaunknown/simple-peer'
import WebTorrent from 'webtorrent'
import { createClientOptions } from '../client-config'
import type { DiskTorrentSession, EngineAddClient } from '../disk-torrent'
import { MediaProxy } from '../media-proxy'
import { EgressPolicy } from '../network-policy'
import { TorrentManager } from '../torrent-manager'
import { validateTorrentMetadata } from '../torrent-metadata'
import {
  PendingSignalingBudget,
  WebrtcSignaling,
  type SignalingPeer
} from '../webrtc-signaling'

/**
 * The section 18.5 soak harness.
 *
 * One process plays both the engine and the local peer it transfers with, so
 * every sample covers strictly more retained state than the shipped utility
 * process holds. The caps are therefore applied conservatively: a run that
 * passes here would also pass against an engine measured on its own.
 *
 * Nothing here reaches a public swarm. The seeder binds an ephemeral loopback
 * port and the downloader admits exactly that one endpoint, which production
 * policy still rejects.
 */

const createTorrentAsync = promisify(createTorrent) as (
  input: string,
  options: Record<string, unknown>
) => Promise<Uint8Array>

/** Small enough that two hundred cycles stay quick, large enough to span pieces. */
const SOAK_PAYLOAD_BYTES = 256 * 1024
const SOAK_TRANSFER_TIMEOUT_MS = 60_000

export type SoakSample = Readonly<{
  cycle: number
  fileDescriptors: number
  heapUsed: number
  rss: number
  sockets: number
  temporaryEntries: number
}>

export type SoakProfile = Readonly<{
  lifecycleCycles: number
  sustainedMs: number
  warmupCycles: number
  webrtcEvery: number
}>

/**
 * The plan's numbers are the gate. `rehearsal` exists so the harness itself
 * can be exercised quickly while it is being changed; it proves nothing.
 */
export function soakProfile(): SoakProfile {
  if (process.env['WEBTORRENT_UPDATED_SOAK_PROFILE'] === 'rehearsal') {
    return {
      lifecycleCycles: 42,
      sustainedMs: 120_000,
      warmupCycles: 2,
      webrtcEvery: 4
    }
  }
  return {
    lifecycleCycles: 200,
    sustainedMs: 30 * 60_000,
    warmupCycles: 10,
    webrtcEvery: 10
  }
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new Error('A median needs at least one sample')
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  if (ordered.length % 2 === 1) return ordered[middle] as number
  return ((ordered[middle - 1] as number) + (ordered[middle] as number)) / 2
}

/** Least-squares slope in units per cycle, so a trend is measured, not guessed. */
export function slopePerCycle(
  points: ReadonlyArray<readonly [number, number]>
): number {
  if (points.length < 2) return 0
  const meanX = points.reduce((total, [x]) => total + x, 0) / points.length
  const meanY = points.reduce((total, [, y]) => total + y, 0) / points.length
  let covariance = 0
  let variance = 0
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY)
    variance += (x - meanX) ** 2
  }
  return variance === 0 ? 0 : covariance / variance
}

/** Open descriptors of this process, which macOS exposes as a directory. */
async function fileDescriptorCount(): Promise<number> {
  try {
    return (await readdir('/dev/fd')).length
  } catch {
    return 0
  }
}

function socketCount(): number {
  return process
    .getActiveResourcesInfo()
    .filter(resource => /TCP|UDP|Socket/u.test(resource)).length
}

async function entryCount(root: string): Promise<number> {
  try {
    return (await readdir(root)).length
  } catch {
    return 0
  }
}

/**
 * Settles the loop, collects garbage where the runtime allows it, and reads
 * the idle checkpoint. Without the collection the heap trend would measure
 * scheduling luck rather than retention.
 */
export async function sampleIdle(
  cycle: number,
  temporaryRoot: string
): Promise<SoakSample> {
  await new Promise(resolve => setTimeout(resolve, 50))
  const collect = (globalThis as { gc?: () => void }).gc
  if (collect) {
    collect()
    await new Promise(resolve => setTimeout(resolve, 10))
    collect()
  }
  const memory = process.memoryUsage()
  return {
    cycle,
    fileDescriptors: await fileDescriptorCount(),
    heapUsed: memory.heapUsed,
    rss: memory.rss,
    sockets: socketCount(),
    temporaryEntries: await entryCount(temporaryRoot)
  }
}

export type SoakFixture = {
  /** The one loopback endpoint the downloader admits, and nothing else. */
  allowedPeer: string
  downloader: WebTorrent
  manager: TorrentManager
  proxy: MediaProxy
  proxyPort: number
  root: string
  seeder: WebTorrent
  sessions: Map<string, DiskTorrentSession>
}

/**
 * The long-lived halves of the soak: two clients, one manager, one media
 * proxy. Torrents churn through them; the clients themselves never restart,
 * which is what makes a retention trend meaningful.
 */
export async function createSoakFixture(): Promise<SoakFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-soak-'))
  const seeder = new WebTorrent(createClientOptions('public'))
  const downloader = new WebTorrent(createClientOptions('public'))

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The soak seeder never bound a port')),
      SOAK_TRANSFER_TIMEOUT_MS
    )
    const poll = setInterval(() => {
      const address = seeder.address()
      if (typeof address === 'object' && address && address.port) {
        clearInterval(poll)
        clearTimeout(timer)
        resolve()
      }
    }, 25)
  })

  const address = seeder.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) throw new Error('The soak seeder never bound a port')

  const sessions = new Map<string, DiskTorrentSession>()
  const allowedPeer = `127.0.0.1:${port}`
  const manager = new TorrentManager({
    resolveClient: () => downloader as unknown as EngineAddClient,
    sessionOptions: {
      createActivation: session => {
        sessions.set(session.infoHash, session)
        return null
      },
      // Exactly the ephemeral endpoint this run created. Production policy
      // still rejects loopback entirely.
      peerFilter: peer => peer === allowedPeer || peer === '127.0.0.1'
    }
  })

  const proxy = new MediaProxy()
  const proxyPort = await proxy.start()

  return {
    allowedPeer,
    downloader,
    manager,
    proxy,
    proxyPort,
    root,
    seeder,
    sessions
  }
}

export async function destroySoakFixture(fixture: SoakFixture): Promise<void> {
  await fixture.manager.closeAll()
  await fixture.proxy.shutdown()
  for (const client of [fixture.seeder, fixture.downloader]) {
    await new Promise<void>(resolve => {
      client.destroy(() => resolve())
    })
  }
  await rm(fixture.root, { force: true, recursive: true })
}

export type SeededTorrent = Readonly<{
  cycleRoot: string
  destinationRoot: string
  metadata: Awaited<ReturnType<typeof validateTorrentMetadata>>
  payload: Uint8Array
}>

/**
 * A freshly generated torrent, already complete on the seeder. Each cycle uses
 * its own info hash so the run exercises registry churn rather than one
 * long-lived record.
 */
export async function seedCycleTorrent(
  fixture: SoakFixture,
  cycle: number
): Promise<SeededTorrent> {
  const cycleRoot = path.join(fixture.root, `cycle-${cycle}`)
  const seedRoot = path.join(cycleRoot, 'seed')
  const destinationRoot = path.join(cycleRoot, 'download')
  await mkdir(seedRoot, { recursive: true })
  await mkdir(destinationRoot, { recursive: true })

  const payload = randomBytes(SOAK_PAYLOAD_BYTES)
  const payloadPath = path.join(seedRoot, 'payload.bin')
  await writeFile(payloadPath, payload)

  const torrentBytes = await createTorrentAsync(payloadPath, {
    announceList: [],
    private: false
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The cycle seed never completed')),
      SOAK_TRANSFER_TIMEOUT_MS
    )
    const torrent = fixture.seeder.add(
      torrentBytes as never,
      { announce: [], path: seedRoot, strategy: 'rarest' } as never
    )
    torrent.on('done', () => {
      clearTimeout(timer)
      resolve()
    })
    torrent.on('error', error => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })

  const metadata = await validateTorrentMetadata(
    torrentBytes,
    new EgressPolicy()
  )
  return { cycleRoot, destinationRoot, metadata, payload }
}

export async function waitFor(
  reached: () => boolean,
  message: string
): Promise<void> {
  const deadline = Date.now() + SOAK_TRANSFER_TIMEOUT_MS
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * A peer built exactly like the engine's, except that its transport is pinned
 * to loopback. Production supplies no bind address, so this reaches only the
 * machine it runs on and needs no network at all.
 */
function createLoopbackPeer(initiator: boolean): SignalingPeer {
  return new SimplePeer({
    config: { bindAddress: '127.0.0.1', iceServers: [] },
    iceCompleteTimeout: 3_000,
    initiator,
    trickle: false
  }) as unknown as SignalingPeer
}

/**
 * Introduces the seeder to the downloader through the engine's own WebRTC
 * signaling and handoff, rather than as a discovered address. The returned
 * function retires both halves of the exchange.
 */
export async function connectSignaledPeer(
  fixture: SoakFixture,
  session: DiskTorrentSession
): Promise<() => void> {
  const signaling = new WebrtcSignaling({
    createPeer: ({ initiator }) => createLoopbackPeer(initiator),
    handoff: peer => session.admitConnection(peer),
    isSelfPeerId: () => false,
    pending: new PendingSignalingBudget()
  })

  const remote = createLoopbackPeer(false) as SignalingPeer & {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown
  }
  remote.id = randomBytes(20).toString('hex')
  const seederTorrent = fixture.seeder.torrents.at(-1)
  if (!seederTorrent) throw new Error('The seeder holds no torrent')
  remote.on('connect', () => {
    seederTorrent.addPeer(remote as never, 'tracker' as never)
  })

  const release = (): void => {
    signaling.close()
    remote.destroy()
  }

  try {
    const [offer] = await signaling.createOffers(1, 'fixture://loopback')
    if (!offer) throw new Error('No offer was generated')

    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The remote peer never answered')),
        SOAK_TRANSFER_TIMEOUT_MS
      )
      remote.on('signal', (...args: unknown[]) => {
        const description = args[0] as { sdp?: string; type?: string }
        if (description.type !== 'answer' || !description.sdp) return
        clearTimeout(timer)
        resolve(description.sdp)
      })
      remote.signal({ sdp: offer.sdp, type: 'offer' })
    })

    signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: randomBytes(20).toString('latin1'),
      sdp: answer
    })

    await waitFor(
      () => session.stats().numPeers > 0,
      'The signaled peer never reached the torrent'
    )
  } catch (error) {
    release()
    throw error
  }

  return release
}

/** Removes the cycle from both clients and takes its bytes off disk. */
export async function retireCycleTorrent(
  fixture: SoakFixture,
  seeded: SeededTorrent
): Promise<void> {
  await fixture.manager.remove(seeded.metadata.infoHash)
  fixture.sessions.delete(seeded.metadata.infoHash)
  await new Promise<void>(resolve => {
    fixture.seeder.remove(seeded.metadata.infoHash, undefined, () => resolve())
  })
  await rm(seeded.cycleRoot, { force: true, recursive: true })
}

/** Reads the transferred bytes back the way playback would, through leases. */
export async function seekThroughProxy(
  fixture: SoakFixture,
  seeded: SeededTorrent,
  seeks: number
): Promise<void> {
  const file = fixture.manager.mediaFile(seeded.metadata.infoHash, 0)
  if (!file) throw new Error('The media file was unavailable')
  const lease = fixture.proxy.open({
    fileIndex: 0,
    infoHash: seeded.metadata.infoHash,
    source: {
      contentType: 'application/octet-stream',
      createReadStream: range => file.createReadStream(range),
      length: file.length
    }
  })

  try {
    for (let seek = 0; seek < seeks; seek += 1) {
      const length = 1_024
      const start = Math.min(
        Math.floor(Math.random() * (SOAK_PAYLOAD_BYTES - length)),
        SOAK_PAYLOAD_BYTES - length
      )
      const response = await fetch(lease.url, {
        headers: { range: `bytes=${start}-${start + length - 1}` }
      })
      if (response.status !== 206) {
        throw new Error(`A seek was refused with status ${response.status}`)
      }
      const chunk = Buffer.from(new Uint8Array(await response.arrayBuffer()))
      if (
        !chunk.equals(Buffer.from(seeded.payload.slice(start, start + length)))
      ) {
        throw new Error('A seek returned bytes the payload does not contain')
      }
    }
  } finally {
    fixture.proxy.close(lease.leaseId)
  }
}

/** Confirms the whole payload really landed, byte for byte. */
export async function assertPayloadTransferred(
  seeded: SeededTorrent
): Promise<void> {
  const downloaded = await readFile(
    path.join(
      seeded.destinationRoot,
      seeded.metadata.files[0]?.path ?? 'payload.bin'
    )
  )
  if (!Buffer.from(downloaded).equals(Buffer.from(seeded.payload))) {
    throw new Error('The transferred payload did not match the seeded bytes')
  }
}
