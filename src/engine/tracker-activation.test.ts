import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TrackerActivation,
  TrackerActivationError,
  TRACKER_ACTIVATION_LIMITS,
  type TrackerActivationOptions
} from './tracker-activation'
import {
  TrackerHttpError,
  type TrackerAnnounceInput,
  type TrackerAnnounceResponse
} from './tracker-http'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

function peerId(): Uint8Array {
  return new TextEncoder().encode('-WU0100-abcdefghijkl')
}

function announceResponse(
  overrides: Partial<TrackerAnnounceResponse> = {}
): TrackerAnnounceResponse {
  return {
    complete: 1,
    incomplete: 2,
    interval: 900,
    minInterval: null,
    peers: [],
    trackerId: null,
    warningMessage: null,
    ...overrides
  }
}

type ScriptedAnnounce = (
  input: TrackerAnnounceInput
) => Promise<TrackerAnnounceResponse>

type Harness = {
  activation: TrackerActivation
  calls: TrackerAnnounceInput[]
  peers: string[]
}

function createActivation(
  overrides: Partial<TrackerActivationOptions> & { respond?: ScriptedAnnounce }
): Harness {
  const calls: TrackerAnnounceInput[] = []
  const peers: string[] = []
  const respond: ScriptedAnnounce =
    overrides.respond ?? (() => Promise.resolve(announceResponse()))
  const rest: Partial<TrackerActivationOptions> = { ...overrides }
  delete (rest as { respond?: ScriptedAnnounce }).respond
  const activation = new TrackerActivation({
    allowHttp: false,
    allowPrivateNetwork: false,
    infoHash: INFO_HASH,
    now: () => Date.now(),
    onPeers: delivery => peers.push(delivery.endpoint),
    peerId: peerId(),
    port: 51_413,
    private: false,
    progress: () => ({ downloaded: 0, left: 1_024, uploaded: 0 }),
    random: () => 0.999_999,
    sessionSeed: 'session-seed',
    tiers: [['https://tracker.one/announce']],
    transport: {
      announce: input => {
        calls.push(input)
        return respond(input)
      }
    },
    ...rest
  })
  return { activation, calls, peers }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-24T12:00:00Z'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

/**
 * Rotation continues in promise continuations, so a chain of immediate
 * retries needs several timer turns before it settles.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

describe('TrackerActivation', () => {
  it('rejects tracker metadata beyond the fixed activation limits', () => {
    expect(() =>
      createActivation({
        tiers: Array.from(
          { length: TRACKER_ACTIVATION_LIMITS.maxTiers + 1 },
          (_value, index) => [`https://tracker.${index}/announce`]
        )
      })
    ).toThrow(TrackerActivationError)

    expect(() =>
      createActivation({
        tiers: [
          Array.from(
            { length: TRACKER_ACTIVATION_LIMITS.maxUrlsPerTier + 1 },
            (_value, index) => `https://tracker.one/${index}`
          )
        ]
      })
    ).toThrow(TrackerActivationError)
  })

  it('deduplicates endpoints by first occurrence and keeps tier order', () => {
    const { activation } = createActivation({
      tiers: [
        ['https://a.test/announce', 'https://b.test/announce'],
        ['https://b.test/announce', 'https://c.test/announce']
      ]
    })

    expect(activation.endpointCount).toBe(3)
    expect(activation.describe().map(unit => unit.key)).toEqual([
      'tier:0',
      'tier:1'
    ])
    expect(
      activation.describe().map(unit => unit.endpoints.map(item => item.url))
    ).toEqual([
      ['https://a.test/announce', 'https://b.test/announce'],
      ['https://c.test/announce']
    ])
  })

  it('starts every public tier concurrently and reannounces on the interval', async () => {
    const { activation, calls, peers } = createActivation({
      respond: () =>
        Promise.resolve(
          announceResponse({
            interval: 600,
            peers: [{ address: '203.0.113.9', family: 4, port: 6881 }]
          })
        ),
      tiers: [['https://a.test/announce'], ['https://b.test/announce']]
    })

    activation.start()
    await settle()

    expect(calls.map(call => call.trackerUrl)).toEqual([
      'https://a.test/announce',
      'https://b.test/announce'
    ])
    expect(calls.every(call => call.event === 'started')).toBe(true)
    expect(peers).toEqual([
      'https://a.test/announce',
      'https://b.test/announce'
    ])

    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toHaveLength(4)
    expect(calls.slice(2).every(call => call.event === undefined)).toBe(true)

    await activation.stop()
  })

  it('honors the larger of interval and minimum interval', async () => {
    const { activation, calls } = createActivation({
      respond: () =>
        Promise.resolve(announceResponse({ interval: 300, minInterval: 900 }))
    })

    activation.start()
    await settle()
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(899_000)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(2)

    await activation.stop()
  })

  it('rotates serially inside a tier and makes the first success sticky', async () => {
    const { activation, calls } = createActivation({
      respond: input =>
        input.trackerUrl === 'https://good.test/announce'
          ? Promise.resolve(announceResponse({ interval: 600 }))
          : Promise.reject(new TrackerHttpError('NETWORK_FAILED')),
      tiers: [['https://bad.test/announce', 'https://good.test/announce']]
    })

    activation.start()
    await settle()

    expect(
      calls.map(call => `${call.trackerUrl}:${call.event ?? 'none'}`)
    ).toEqual([
      'https://bad.test/announce:started',
      'https://bad.test/announce:stopped',
      'https://good.test/announce:started'
    ])
    const [tier] = activation.describe()
    expect(tier?.endpoints[0]?.url).toBe('https://good.test/announce')
    expect(tier?.endpoints[0]?.active).toBe(true)
    expect(tier?.succeeded).toBe(true)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls.at(-1)?.trackerUrl).toBe('https://good.test/announce')

    await activation.stop()
  })

  it('backs off deterministically after a whole tier fails', async () => {
    const { activation, calls } = createActivation({
      respond: () => Promise.reject(new TrackerHttpError('NETWORK_FAILED')),
      tiers: [['https://a.test/announce', 'https://b.test/announce']]
    })

    activation.start()
    await settle()

    const announces = calls.filter(call => call.event !== 'stopped')
    expect(announces).toHaveLength(2)
    expect(activation.describe()[0]?.failureRound).toBe(1)

    await vi.advanceTimersByTimeAsync(53_999)
    expect(calls.filter(call => call.event !== 'stopped')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(
      TRACKER_ACTIVATION_LIMITS.maxBackoffSeconds * 1_000
    )
    expect(
      calls.filter(call => call.event !== 'stopped').length
    ).toBeGreaterThan(2)

    await activation.stop()
  })

  it('keeps exactly one private endpoint active and retires its generation', async () => {
    const retired: number[] = []
    let attempt = 0
    const { activation, calls } = createActivation({
      onRetireGeneration: () => {
        retired.push(attempt)
      },
      private: true,
      respond: () => {
        attempt += 1
        return attempt === 1
          ? Promise.reject(new TrackerHttpError('NETWORK_FAILED'))
          : Promise.resolve(announceResponse())
      },
      tiers: [['https://one.test/announce'], ['https://two.test/announce']]
    })

    expect(activation.describe()).toHaveLength(1)

    activation.start()
    await settle()

    expect(retired).toHaveLength(1)
    expect(
      calls
        .filter(call => call.event === 'started')
        .map(call => call.trackerUrl)
    ).toEqual(['https://one.test/announce', 'https://two.test/announce'])
    expect(
      calls.some(
        call =>
          call.event === 'stopped' &&
          call.trackerUrl === 'https://one.test/announce'
      )
    ).toBe(true)

    await activation.stop()
  })

  it('awaits private stopped teardown before retiring and activating failover', async () => {
    let finishStopped: (() => void) | null = null
    const order: string[] = []
    const { activation } = createActivation({
      onRetireGeneration: () => {
        order.push('retire')
      },
      private: true,
      respond: input => {
        if (
          input.trackerUrl === 'https://one.test/announce' &&
          input.event === 'started'
        ) {
          return Promise.reject(new TrackerHttpError('NETWORK_FAILED'))
        }
        if (
          input.trackerUrl === 'https://one.test/announce' &&
          input.event === 'stopped'
        ) {
          order.push('stopped')
          return new Promise<TrackerAnnounceResponse>(resolve => {
            finishStopped = () => {
              order.push('stopped-finished')
              resolve(announceResponse())
            }
          })
        }
        order.push('replacement')
        return Promise.resolve(announceResponse())
      },
      tiers: [['https://one.test/announce'], ['https://two.test/announce']]
    })

    activation.start()
    await settle()
    expect(order).toEqual(['stopped'])

    ;(finishStopped as (() => void) | null)?.()
    await settle()
    expect(order.slice(0, 3)).toEqual(['stopped', 'stopped-finished', 'retire'])
    expect(order).toContain('replacement')

    await activation.stop()
  })

  it('reports single-pass exhaustion only after private retirement', async () => {
    const order: string[] = []
    const { activation } = createActivation({
      onExhausted: () => order.push('exhausted'),
      onRetireGeneration: () => {
        order.push('retired')
      },
      private: true,
      respond: input => {
        if (input.event === 'stopped') {
          order.push('stopped')
          return Promise.resolve(announceResponse())
        }
        return Promise.reject(new TrackerHttpError('NETWORK_FAILED'))
      },
      singlePass: true
    })

    activation.start()
    await settle()

    expect(order).toEqual(['stopped', 'retired', 'exhausted'])
    await activation.stop()
  })

  it('sends completed once and keeps announcing while seeding', async () => {
    let left = 1_024
    const { activation, calls } = createActivation({
      progress: () => ({ downloaded: 1_024 - left, left, uploaded: 0 }),
      respond: () => Promise.resolve(announceResponse({ interval: 600 }))
    })

    activation.start()
    await settle()

    left = 0
    activation.notifyCompleted()
    activation.notifyCompleted()
    await settle()

    expect(calls.filter(call => call.event === 'completed')).toHaveLength(1)
    expect(calls.at(-1)?.left).toBe(0)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls.at(-1)?.event).toBeUndefined()

    await activation.stop()
  })

  it('never sends completed for an activation that began seeding', async () => {
    const { activation, calls } = createActivation({
      progress: () => ({ downloaded: 4_096, left: 0, uploaded: 0 })
    })

    activation.start()
    await settle()
    activation.notifyCompleted()
    await settle()

    expect(calls.filter(call => call.event === 'completed')).toHaveLength(0)

    await activation.stop()
  })

  it('defers on local capacity rejection without rotating or failing', async () => {
    let rejectOnce = true
    const { activation, calls } = createActivation({
      respond: () => {
        if (rejectOnce) {
          rejectOnce = false
          return Promise.reject(new TrackerHttpError('CONCURRENCY_LIMIT'))
        }
        return Promise.resolve(announceResponse())
      },
      tiers: [['https://a.test/announce', 'https://b.test/announce']]
    })

    activation.start()
    await settle()
    expect(calls).toHaveLength(1)
    expect(activation.describe()[0]?.failureRound).toBe(0)

    await vi.advanceTimersByTimeAsync(TRACKER_ACTIVATION_LIMITS.localDeferralMs)
    expect(calls).toHaveLength(2)
    expect(
      calls.every(call => call.trackerUrl === 'https://a.test/announce')
    ).toBe(true)

    await activation.stop()
  })

  it('attempts one stopped announce per contacted endpoint on teardown', async () => {
    const { activation, calls } = createActivation({
      respond: input =>
        input.trackerUrl === 'https://a.test/announce'
          ? Promise.resolve(announceResponse())
          : Promise.reject(new TrackerHttpError('NETWORK_FAILED')),
      tiers: [['https://a.test/announce'], ['https://b.test/announce']]
    })

    activation.start()
    await settle()

    const stopPromise = activation.stop()
    await vi.advanceTimersByTimeAsync(TRACKER_ACTIVATION_LIMITS.stopGraceMs)
    await stopPromise
    await activation.stop()

    const stopped = calls.filter(call => call.event === 'stopped')
    expect(stopped.map(call => call.trackerUrl).sort()).toEqual([
      'https://a.test/announce',
      'https://b.test/announce'
    ])
    expect(
      activation
        .describe()
        .flatMap(unit => unit.endpoints)
        .every(endpoint => endpoint.stoppedAttempted)
    ).toBe(true)
  })

  it('stops scheduling and ignores late responses after teardown', async () => {
    const inFlight: {
      release: ((response: TrackerAnnounceResponse) => void) | null
    } = { release: null }
    const { activation, calls } = createActivation({
      respond: () =>
        new Promise<TrackerAnnounceResponse>(resolve => {
          inFlight.release = resolve
        })
    })

    activation.start()
    await settle()
    expect(calls).toHaveLength(1)

    const stopPromise = activation.stop()
    inFlight.release?.(announceResponse({ interval: 60 }))
    await vi.advanceTimersByTimeAsync(TRACKER_ACTIVATION_LIMITS.stopGraceMs)
    await stopPromise

    const before = calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toHaveLength(before)
  })
})
