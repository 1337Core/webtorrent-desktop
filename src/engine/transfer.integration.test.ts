import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createTorrent from 'create-torrent'
import WebTorrent from 'webtorrent'
import { createClientOptions } from './client-config'
import SimplePeer from '@thaunknown/simple-peer'
import { MediaProxy } from './media-proxy'
import { EgressPolicy } from './network-policy'
import { TorrentManager } from './torrent-manager'
import {
  PendingSignalingBudget,
  WebrtcSignaling,
  type SignalingPeer
} from './webrtc-signaling'
import { validateTorrentMetadata } from './torrent-metadata'
import type { DiskTorrentSession, EngineAddClient } from './disk-torrent'

const createTorrentAsync = promisify(createTorrent) as (
  input: string,
  options: Record<string, unknown>
) => Promise<Uint8Array>

const PAYLOAD_BYTES = 512 * 1024
const TRANSFER_TIMEOUT_MS = 60_000

type Fixture = {
  /** The exact loopback endpoint the fixture peer filter admits, and nothing else. */
  allowedPeer: string
  payloads: ReadonlyArray<Uint8Array>
  root: string
  seeder: WebTorrent
  torrentBytes: Uint8Array
}

const created: Array<{ client: WebTorrent; root: string }> = []

async function destroyClient(client: WebTorrent): Promise<void> {
  await new Promise<void>(resolve => {
    client.destroy(() => resolve())
  })
}

/**
 * A complete local seeder for one generated payload.
 *
 * It is added exactly as the engine adds a torrent — validated bytes plus an
 * existing path — rather than through `client.seed()`, so the fixture exercises
 * the same acquisition shape as production.
 */
async function seedLocally(fileCount = 1): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-xfer-'))
  const seedRoot = path.join(root, 'seed')
  const contentRoot =
    fileCount === 1 ? seedRoot : path.join(seedRoot, 'payloads')
  await mkdir(contentRoot, { recursive: true })

  const payloads: Uint8Array[] = []
  for (let index = 0; index < fileCount; index += 1) {
    const payload = randomBytes(PAYLOAD_BYTES)
    payloads.push(payload)
    await writeFile(path.join(contentRoot, payloadName(index)), payload)
  }

  const torrentBytes = await createTorrentAsync(
    fileCount === 1 ? path.join(contentRoot, payloadName(0)) : contentRoot,
    {
      announceList: [],
      private: false
    }
  )

  const seeder = new WebTorrent(createClientOptions('public'))
  created.push({ client: seeder, root })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The local seeder never became ready')),
      TRANSFER_TIMEOUT_MS
    )
    seeder.on('error', error => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    const torrent = seeder.add(
      torrentBytes as never,
      {
        announce: [],
        path: seedRoot,
        strategy: 'rarest'
      } as never
    )
    torrent.on('done', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  const address = seeder.address()
  const port = typeof address === 'object' && address ? address.port : 0
  if (!port) throw new Error('The local seeder never bound a port')

  return {
    allowedPeer: `127.0.0.1:${port}`,
    payloads,
    root,
    seeder,
    torrentBytes
  }
}

function payloadName(index: number): string {
  return `payload-${index}.bin`
}

/**
 * A peer built exactly like the engine's, except that its transport is pinned
 * to loopback. Production supplies no bind address, so this fixture reaches
 * only the machine it runs on and needs no network at all.
 */
function createLoopbackPeer(initiator: boolean): SignalingPeer {
  return new SimplePeer({
    config: { bindAddress: '127.0.0.1', iceServers: [] },
    iceCompleteTimeout: 3_000,
    initiator,
    trickle: false
  }) as unknown as SignalingPeer
}

beforeEach(() => {
  created.length = 0
})

afterEach(async () => {
  for (const entry of created) {
    await destroyClient(entry.client)
  }
  for (const entry of created) {
    await rm(entry.root, { force: true, recursive: true })
  }
  created.length = 0
})

type Downloader = {
  destinationRoot: string
  manager: TorrentManager
  session: () => DiskTorrentSession
}

/** One engine-side downloader wired to the fixture's single allowed peer. */
async function downloaderFor(
  fixture: Fixture,
  metadata: Awaited<ReturnType<typeof validateTorrentMetadata>>,
  selectedIndexes: ReadonlyArray<number>,
  overrides: Readonly<{ peerFilter?: (address: string) => boolean }> = {}
): Promise<Downloader> {
  const destinationRoot = path.join(fixture.root, 'download')
  await mkdir(destinationRoot, { recursive: true })

  const client = new WebTorrent(createClientOptions('public'))
  created.push({ client, root: path.join(fixture.root, 'unused') })

  let opened: DiskTorrentSession | null = null
  const manager = new TorrentManager({
    resolveClient: () => client as unknown as EngineAddClient,
    sessionOptions: {
      // The activation factory is the engine's own per-torrent hook; the
      // fixture uses it to reach the session and starts no announce.
      createActivation: session => {
        opened = session
        return null
      },
      // The fixture reaches exactly the one ephemeral loopback endpoint the
      // test created. Production policy still rejects loopback entirely.
      peerFilter:
        overrides.peerFilter ?? (address => address === fixture.allowedPeer)
    }
  })

  await manager.add({ destinationRoot, metadata, selectedIndexes })
  await manager.resume(metadata.infoHash)

  return {
    destinationRoot,
    manager,
    session: () => {
      const session = opened as DiskTorrentSession | null
      if (!session) throw new Error('The session was never created')
      return session
    }
  }
}

/** Waits for a condition the transfer is expected to reach. */
async function waitFor(reached: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + TRANSFER_TIMEOUT_MS
  while (!reached()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('engine transfer', () => {
  it(
    'downloads a whole torrent from a local TCP peer',
    async () => {
      const fixture = await seedLocally()
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const destinationRoot = path.join(fixture.root, 'download')
      await mkdir(destinationRoot, { recursive: true })

      const client = new WebTorrent(createClientOptions('public'))
      created.push({ client, root: path.join(fixture.root, 'unused') })

      let session: DiskTorrentSession | null = null
      const manager = new TorrentManager({
        resolveClient: () => client as unknown as EngineAddClient,
        sessionOptions: {
          // The activation factory is the engine's own per-torrent hook; the
          // fixture uses it to reach the session and starts no announce.
          createActivation: created => {
            session = created
            return null
          },
          // The fixture reaches exactly the one ephemeral loopback endpoint the
          // test created. Production policy still rejects loopback entirely.
          peerFilter: address => address === fixture.allowedPeer
        }
      })

      const expectedPath = path.join(destinationRoot, payloadName(0))
      expect(existsSync(expectedPath)).toBe(false)

      const summary = await manager.add({
        destinationRoot,
        metadata,
        selectedIndexes: [0]
      })
      expect(summary.infoHash).toBe(metadata.infoHash)

      await manager.resume(metadata.infoHash)
      const admitting = session as DiskTorrentSession | null
      if (!admitting) throw new Error('The session was never created')
      expect(admitting.admitPeer(fixture.allowedPeer)).toBe(true)
      // Nothing outside the allow-set may be handed to WebTorrent.
      expect(admitting.admitPeer('127.0.0.1:1')).toBe(false)

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The transfer never completed')),
          TRANSFER_TIMEOUT_MS
        )
        const poll = setInterval(() => {
          if (manager.summary(metadata.infoHash).progress >= 1) {
            clearInterval(poll)
            clearTimeout(timer)
            resolve()
          }
        }, 100)
      })

      const stats = admitting.stats()
      // The payload really crossed a wire: bytes arrived from one peer.
      expect(stats.downloaded).toBeGreaterThanOrEqual(PAYLOAD_BYTES)
      expect(stats.numPeers).toBeGreaterThanOrEqual(1)
      expect(stats.done).toBe(true)

      const downloaded = await readFile(
        path.join(destinationRoot, metadata.files[0]?.path ?? payloadName(0))
      )
      expect(downloaded.byteLength).toBe(PAYLOAD_BYTES)
      expect(
        Buffer.from(downloaded).equals(Buffer.from(fixture.payloads[0] ?? []))
      ).toBe(true)
      await manager.closeAll()
    },
    TRANSFER_TIMEOUT_MS
  )

  it(
    'downloads only the selected file of a multi-file torrent',
    async () => {
      const fixture = await seedLocally(2)
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const wanted = metadata.files.findIndex(file =>
        file.path.endsWith(payloadName(1))
      )
      expect(wanted).toBeGreaterThanOrEqual(0)

      const downloader = await downloaderFor(fixture, metadata, [wanted])
      expect(downloader.session().admitPeer(fixture.allowedPeer)).toBe(true)

      await waitFor(
        () => downloader.session().stats().downloaded >= PAYLOAD_BYTES,
        'The selected file never completed'
      )

      const stats = downloader.session().stats()
      const other = wanted === 0 ? 1 : 0
      // Exactly the selected file's bytes crossed the wire, and the
      // deselected file received none of them.
      expect(stats.downloaded).toBe(PAYLOAD_BYTES)
      expect(stats.fileDownloaded[other]).toBe(0)
      expect(stats.done).toBe(false)

      const selectedPath = path.join(
        downloader.destinationRoot,
        metadata.files[wanted]?.path ?? ''
      )
      const downloaded = await readFile(selectedPath)
      expect(
        Buffer.from(downloaded).equals(Buffer.from(fixture.payloads[1] ?? []))
      ).toBe(true)

      await downloader.manager.closeAll()
    },
    TRANSFER_TIMEOUT_MS
  )

  it(
    'admits nothing while paused and resumes to completion',
    async () => {
      const fixture = await seedLocally()
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const downloader = await downloaderFor(fixture, metadata, [0])

      await downloader.manager.pause(metadata.infoHash)
      // A paused generation admits no peer at all, whatever discovered it.
      expect(downloader.session().admitPeer(fixture.allowedPeer)).toBe(false)
      expect(downloader.session().stats().numPeers).toBe(0)

      await downloader.manager.resume(metadata.infoHash)
      expect(downloader.session().admitPeer(fixture.allowedPeer)).toBe(true)

      await waitFor(
        () => downloader.manager.summary(metadata.infoHash).progress >= 1,
        'The resumed transfer never completed'
      )

      await downloader.manager.closeAll()
    },
    TRANSFER_TIMEOUT_MS
  )

  it(
    'releases the info hash only after removal completes',
    async () => {
      const fixture = await seedLocally()
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const downloader = await downloaderFor(fixture, metadata, [0])
      expect(downloader.manager.registry.has(metadata.infoHash)).toBe(true)

      await downloader.manager.remove(metadata.infoHash)

      expect(downloader.manager.registry.has(metadata.infoHash)).toBe(false)
      expect(() => downloader.manager.summary(metadata.infoHash)).toThrow()
      // The hash is genuinely gone: a repeat is an explicit NOT_FOUND rather
      // than a second destroy of live state.
      await expect(
        downloader.manager.remove(metadata.infoHash)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await downloader.manager.closeAll()
    },
    TRANSFER_TIMEOUT_MS
  )

  it(
    'streams the transferred payload through the loopback proxy',
    async () => {
      const fixture = await seedLocally()
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const downloader = await downloaderFor(fixture, metadata, [0])
      expect(downloader.session().admitPeer(fixture.allowedPeer)).toBe(true)
      await waitFor(
        () => downloader.manager.summary(metadata.infoHash).progress >= 1,
        'The transfer never completed'
      )

      const proxy = new MediaProxy()
      const port = await proxy.start()
      const file = downloader.manager.mediaFile(metadata.infoHash, 0)
      if (!file) throw new Error('The media file was unavailable')
      const lease = proxy.open({
        fileIndex: 0,
        infoHash: metadata.infoHash,
        source: {
          contentType: 'application/octet-stream',
          createReadStream: range => file.createReadStream(range),
          length: file.length
        }
      })

      try {
        expect(lease.url.startsWith(`http://127.0.0.1:${port}/`)).toBe(true)

        const ranged = await fetch(lease.url, {
          headers: { range: 'bytes=1024-2047' }
        })
        expect(ranged.status).toBe(206)
        const chunk = new Uint8Array(await ranged.arrayBuffer())
        expect(chunk.byteLength).toBe(1_024)
        expect(
          Buffer.from(chunk).equals(
            Buffer.from((fixture.payloads[0] as Uint8Array).slice(1_024, 2_048))
          )
        ).toBe(true)

        // The lease token is the only route: the index is not served.
        const index = await fetch(`http://127.0.0.1:${port}/`)
        expect(index.status).toBe(404)
      } finally {
        await proxy.shutdown()
        await downloader.manager.closeAll()
      }
    },
    TRANSFER_TIMEOUT_MS
  )

  it(
    'transfers a torrent to a peer that arrived over native WebRTC',
    async () => {
      const fixture = await seedLocally()
      const metadata = await validateTorrentMetadata(
        fixture.torrentBytes,
        new EgressPolicy()
      )
      const downloader = await downloaderFor(fixture, metadata, [0], {
        // A WebRTC transport reports its remote address without a port.
        peerFilter: address => address === '127.0.0.1'
      })

      const signaling = new WebrtcSignaling({
        createPeer: ({ initiator }) => createLoopbackPeer(initiator),
        handoff: peer => downloader.session().admitConnection(peer),
        isSelfPeerId: () => false,
        pending: new PendingSignalingBudget()
      })

      // The remote half of the exchange: the peer a tracker would introduce.
      const remote = createLoopbackPeer(false) as SignalingPeer & {
        on: (event: string, listener: (...args: unknown[]) => void) => unknown
      }
      remote.id = randomBytes(20).toString('hex')
      const seederTorrent = fixture.seeder.torrents[0]
      if (!seederTorrent) throw new Error('The seeder holds no torrent')
      remote.on('connect', () => {
        seederTorrent.addPeer(remote as never, 'tracker' as never)
      })

      try {
        const [offer] = await signaling.createOffers(1, 'fixture://loopback')
        if (!offer) throw new Error('No offer was generated')

        const answer = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('The remote peer never answered')),
            TRANSFER_TIMEOUT_MS
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
          () => downloader.session().stats().numPeers > 0,
          'The signaled peer never reached the torrent'
        )
        await waitFor(
          () => downloader.manager.summary(metadata.infoHash).progress >= 1,
          'The WebRTC transfer never completed'
        )

        const downloaded = await readFile(
          path.join(downloader.destinationRoot, payloadName(0))
        )
        expect(
          Buffer.from(downloaded).equals(
            Buffer.from(fixture.payloads[0] as Uint8Array)
          )
        ).toBe(true)
      } finally {
        signaling.close()
        remote.destroy()
        await downloader.manager.closeAll()
      }
    },
    TRANSFER_TIMEOUT_MS
  )
})
