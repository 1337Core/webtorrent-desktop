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
import { EgressPolicy } from './network-policy'
import { TorrentManager } from './torrent-manager'
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
  payload: Uint8Array
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
async function seedLocally(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-xfer-'))
  const seedRoot = path.join(root, 'seed')
  await mkdir(seedRoot, { recursive: true })
  const payload = randomBytes(PAYLOAD_BYTES)
  const payloadPath = path.join(seedRoot, 'payload.bin')
  await writeFile(payloadPath, payload)

  const torrentBytes = await createTorrentAsync(payloadPath, {
    announceList: [],
    private: false
  })

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
    payload,
    root,
    seeder,
    torrentBytes
  }
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

      const expectedPath = path.join(destinationRoot, 'payload.bin')
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
        path.join(destinationRoot, metadata.files[0]?.path ?? 'payload.bin')
      )
      expect(downloaded.byteLength).toBe(PAYLOAD_BYTES)
      expect(Buffer.from(downloaded).equals(Buffer.from(fixture.payload))).toBe(
        true
      )
      await manager.closeAll()
    },
    TRANSFER_TIMEOUT_MS
  )
})
