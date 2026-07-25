import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertPayloadTransferred,
  connectSignaledPeer,
  createSoakFixture,
  destroySoakFixture,
  median,
  retireCycleTorrent,
  sampleIdle,
  seedCycleTorrent,
  seekThroughProxy,
  slopePerCycle,
  soakProfile,
  waitFor,
  type SoakFixture,
  type SoakSample
} from './harness'

/**
 * Section 18.5 soak and resource tests.
 *
 * These do not run in `npm test`: the file is deliberately outside the default
 * Vitest include and is reached only through `npm run soak`, because a
 * faithful run takes the better part of an hour.
 */

const MIB = 1024 * 1024
const KIB = 1024
const SAMPLE_WINDOW = 20

const profile = soakProfile()
let fixture: SoakFixture

/**
 * One complete add/verify/pause/resume/stream/remove pass.
 *
 * `transport` chooses how the single peer reaches the torrent: a discovered
 * loopback address, or a peer that arrived through the engine's own WebRTC
 * signaling and handoff over the native `node-datachannel` path.
 */
async function runCycle(
  cycle: number,
  seeks: number,
  transport: 'tcp' | 'webrtc' = 'tcp'
): Promise<void> {
  const seeded = await seedCycleTorrent(fixture, cycle)
  const { infoHash } = seeded.metadata

  await fixture.manager.add({
    destinationRoot: seeded.destinationRoot,
    metadata: seeded.metadata,
    selectedIndexes: [0]
  })
  await fixture.manager.resume(infoHash)

  const session = fixture.sessions.get(infoHash)
  if (!session) throw new Error('The cycle session was never created')

  let releasePeer: (() => void) | null = null
  if (transport === 'webrtc') {
    releasePeer = await connectSignaledPeer(fixture, session)
  } else {
    expect(session.admitPeer(fixture.allowedPeer)).toBe(true)
  }

  try {
    await waitFor(
      () => fixture.manager.summary(infoHash).progress >= 1,
      `Cycle ${cycle} never completed its transfer`
    )
    await assertPayloadTransferred(seeded)

    await fixture.manager.pause(infoHash)
    // A paused generation admits nothing further, whatever discovered it.
    expect(session.admitPeer(fixture.allowedPeer)).toBe(false)
    await fixture.manager.resume(infoHash)
    // The already-connected peer is not re-admitted — a second handoff of the
    // same address is a duplicate — so the resumed generation is read from the
    // session itself.
    expect(session.snapshot().state).toBe('running')

    await seekThroughProxy(fixture, seeded, seeks)
  } finally {
    releasePeer?.()
  }

  await retireCycleTorrent(fixture, seeded)

  // Removal must release the whole record, not merely stop it.
  expect(fixture.manager.registry.has(infoHash)).toBe(false)
  expect(fixture.manager.size).toBe(0)
}

/**
 * Applies the plan's retention caps to one series of idle checkpoints. The
 * first and last twenty samples are compared, and the fitted trend across the
 * whole series has to stay inside its per-cycle allowance.
 */
function assertRetentionCaps(samples: ReadonlyArray<SoakSample>): void {
  expect(samples.length).toBeGreaterThanOrEqual(SAMPLE_WINDOW * 2)
  const first = samples.slice(0, SAMPLE_WINDOW)
  const last = samples.slice(-SAMPLE_WINDOW)

  const rssGrowth = median(last.map(s => s.rss)) - median(first.map(s => s.rss))
  expect(rssGrowth).toBeLessThanOrEqual(64 * MIB)
  expect(
    slopePerCycle(samples.map(s => [s.cycle, s.rss] as const))
  ).toBeLessThanOrEqual(256 * KIB)

  const heapGrowth =
    median(last.map(s => s.heapUsed)) - median(first.map(s => s.heapUsed))
  expect(heapGrowth).toBeLessThanOrEqual(16 * MIB)
  expect(
    slopePerCycle(samples.map(s => [s.cycle, s.heapUsed] as const))
  ).toBeLessThanOrEqual(64 * KIB)
}

beforeAll(async () => {
  fixture = await createSoakFixture()
}, 120_000)

afterAll(async () => {
  if (fixture) await destroySoakFixture(fixture)
}, 120_000)

describe('engine soak', () => {
  it(
    'holds its resource budget across the full lifecycle run',
    async () => {
      for (let warmup = 0; warmup < profile.warmupCycles; warmup += 1) {
        await runCycle(-1 - warmup, 2)
      }

      // The baseline is taken after warm-up, so lazily created buffers, pools,
      // and compiled code are already paid for.
      const baseline = await sampleIdle(0, fixture.root)
      const samples: SoakSample[] = []
      for (let cycle = 1; cycle <= profile.lifecycleCycles; cycle += 1) {
        await runCycle(cycle, 2)
        samples.push(await sampleIdle(cycle, fixture.root))
      }

      assertRetentionCaps(samples)

      const final = samples.at(-1) as SoakSample
      // Descriptors and sockets return to where warm-up left them: nothing
      // torrent-specific survives its own removal.
      expect(
        Math.abs(final.fileDescriptors - baseline.fileDescriptors)
      ).toBeLessThanOrEqual(2)
      expect(Math.abs(final.sockets - baseline.sockets)).toBeLessThanOrEqual(2)
      // Every cycle root was created and removed, so the soak root is empty.
      expect(final.temporaryEntries).toBe(0)
      // The engine holds no torrent, and no child process was ever needed.
      expect(fixture.manager.size).toBe(0)
      expect(fixture.seeder.torrents.length).toBe(0)
      expect(fixture.downloader.torrents.length).toBe(0)
    },
    profile.lifecycleCycles * 30_000 + 600_000
  )

  it(
    'sustains transfer and seek for the full soak duration',
    async () => {
      const deadline = Date.now() + profile.sustainedMs
      const samples: SoakSample[] = []
      let cycle = 0
      while (Date.now() < deadline) {
        cycle += 1
        // A sustained run is seek-heavy: playback is the workload, not an
        // afterthought once the bytes have landed. Every `webrtcEvery`th cycle
        // runs over native WebRTC instead of TCP, so both transports stay
        // under load for the whole duration.
        await runCycle(
          cycle,
          8,
          cycle % profile.webrtcEvery === 0 ? 'webrtc' : 'tcp'
        )
        samples.push(await sampleIdle(cycle, fixture.root))
      }

      expect(cycle).toBeGreaterThanOrEqual(SAMPLE_WINDOW * 2)
      assertRetentionCaps(samples)
      const final = samples.at(-1) as SoakSample
      expect(final.temporaryEntries).toBe(0)
      expect(fixture.manager.size).toBe(0)
    },
    profile.sustainedMs + 600_000
  )
})
