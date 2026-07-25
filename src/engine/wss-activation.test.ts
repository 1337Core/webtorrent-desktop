import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSS_ACTIVATION_LIMITS, WssActivation } from './wss-activation'
import { WSS_TRACKER_LIMITS, type WssSocket } from './wss-tracker'

const INFO_HASH = 'a'.repeat(20)
const PEER_ID = 'b'.repeat(20)
const REMOTE_PEER_ID = 'd'.repeat(20)

function sdp(): string {
  return [
    'v=0',
    'o=- 1 1 IN IP4 0.0.0.0',
    's=-',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=candidate:1 1 udp 1 93.184.216.34 6881 typ host'
  ].join('\r\n')
}

class FakeSocket extends EventEmitter implements WssSocket {
  bufferedAmount = 0
  closed = false
  terminated = false
  /** Frames accepted before the transport starts refusing, if ever. */
  acceptLimit = Number.POSITIVE_INFINITY
  readonly sent: string[] = []
  response: 'failure' | 'none' | 'success' = 'success'

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    if (this.sent.length >= this.acceptLimit) throw new Error('refused')
    this.sent.push(data)
    const frame = JSON.parse(data) as {
      answer?: unknown
      event?: string
      info_hash?: string
    }
    if (frame.answer !== undefined || frame.event === 'stopped') return
    if (this.response === 'none') return
    queueMicrotask(() => {
      this.deliver({
        action: 'announce',
        ...(this.response === 'failure'
          ? { 'failure reason': 'tracker refused' }
          : {}),
        info_hash: frame.info_hash
      })
    })
  }

  terminate(): void {
    this.terminated = true
  }

  deliver(payload: unknown): void {
    this.emit('message', JSON.stringify(payload), false)
  }
}

type Harness = {
  activated: string[]
  activation: WssActivation
  /** Every endpoint an offer was generated for, in request order. */
  offerEndpoints: string[]
  offers: Array<{ offer: WssRemoteOffer; trackerUrl: string }>
  opened: string[]
  respond: (answer: Readonly<{ offerId: string; sdp: string }>) => void
  sockets: Map<string, FakeSocket>
}

type WssRemoteOffer = Readonly<{
  offerId: string
  peerId: string
  sdp: string
}>

function harness(
  options: {
    /** Frames each named endpoint accepts before its transport refuses. */
    acceptLimits?: ReadonlyMap<string, number>
    exhaust?: () => void
    refuse?: ReadonlySet<string>
    responses?: ReadonlyMap<string, FakeSocket['response']>
    retire?: (url: string) => void
    serialRetirement?: boolean
    tiers?: ReadonlyArray<ReadonlyArray<string>>
  } = {}
): Harness {
  const opened: string[] = []
  const activated: string[] = []
  const offerEndpoints: string[] = []
  const offers: Harness['offers'] = []
  const sockets = new Map<string, FakeSocket>()
  const refuse = options.refuse ?? new Set<string>()
  let respond: Harness['respond'] = () => undefined

  const activation = new WssActivation({
    allowPrivateNetwork: false,
    connectSocket: async ({ url }) => {
      opened.push(url)
      if (refuse.has(url)) throw new Error('refused')
      const socket = new FakeSocket()
      const limit = options.acceptLimits?.get(url)
      if (limit !== undefined) socket.acceptLimit = limit
      socket.response = options.responses?.get(url) ?? 'success'
      sockets.set(url, socket)
      // The endpoint attaches its listeners synchronously after this
      // resolves, so the open event is delivered on the next turn.
      setTimeout(() => socket.emit('open'), 0)
      return socket
    },
    createOffers: async (count, trackerUrl) => {
      offerEndpoints.push(trackerUrl)
      return Array.from({ length: count }, (_value, index) => ({
        offerId: `${index}`.repeat(20).slice(0, 20),
        sdp: sdp()
      }))
    },
    infoHash: INFO_HASH,
    onActivated: url => activated.push(url),
    onAnswer: () => undefined,
    onExhausted: options.exhaust,
    onOffer: (offer, trackerUrl, reply) => {
      offers.push({ offer, trackerUrl })
      respond = reply
    },
    onRetireEndpoint: options.retire,
    peerId: PEER_ID,
    progress: () => ({ downloaded: 0, left: 10, uploaded: 0 }),
    serialRetirement: options.serialRetirement,
    tiers: options.tiers ?? [['wss://one.example'], ['wss://two.example']]
  })

  return {
    activated,
    activation,
    offerEndpoints,
    offers,
    opened,
    respond: answer => respond(answer),
    sockets
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Drives both the open event and the endpoint's announce promise. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

describe('WssActivation', () => {
  it('opens every tier and announces started on each', async () => {
    const context = harness()

    const started = context.activation.start()
    await settle()
    await started

    expect(context.activation.snapshot().live).toEqual([
      'wss://one.example',
      'wss://two.example'
    ])
    expect(context.activated).toEqual([
      'wss://one.example',
      'wss://two.example'
    ])
    for (const socket of context.sockets.values()) {
      expect(socket.sent).toHaveLength(1)
      expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
        event: 'started',
        numwant: WSS_ACTIVATION_LIMITS.maxOffersPerAnnounce
      })
    }
  })

  it('does not activate until the matching started response arrives', async () => {
    const url = 'wss://one.example'
    const context = harness({
      responses: new Map([[url, 'none']]),
      tiers: [[url]]
    })

    const started = context.activation.start()
    await settle()
    expect(context.activated).toEqual([])

    const socket = context.sockets.get(url)
    if (!socket) throw new Error('The endpoint never opened')
    socket.deliver({ action: 'announce', info_hash: INFO_HASH })
    await settle()
    await started

    expect(context.activated).toEqual([url])
  })

  it('exhausts a staging endpoint after a tracker failure response', async () => {
    const events: string[] = []
    const url = 'wss://one.example'
    const context = harness({
      exhaust: () => events.push('exhausted'),
      responses: new Map([[url, 'failure']]),
      retire: () => events.push('retired'),
      serialRetirement: true,
      tiers: [[url]]
    })

    const started = context.activation.start()
    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.terminateGraceMs + 20)
    await settle()
    await started

    expect(context.activated).toEqual([])
    expect(events).toEqual(['retired', 'exhausted'])
  })

  it.each(['close', 'error'] as const)(
    'exhausts an active staging endpoint after socket %s',
    async event => {
      const exhausted = vi.fn()
      const url = 'wss://one.example'
      const context = harness({
        exhaust: exhausted,
        serialRetirement: true,
        tiers: [[url]]
      })
      const started = context.activation.start()
      await settle()
      await started

      const socket = context.sockets.get(url)
      if (!socket) throw new Error('The endpoint never opened')
      socket.emit(event, ...(event === 'error' ? [new Error('failed')] : []))
      await settle()

      expect(exhausted).toHaveBeenCalledOnce()
      expect(context.activation.snapshot().live).toEqual([])
    }
  )

  it('tries one endpoint from every tier before any tier’s second', async () => {
    const context = harness({
      refuse: new Set([
        'wss://a1.example',
        'wss://a2.example',
        'wss://b1.example',
        'wss://b2.example'
      ]),
      tiers: [
        ['wss://a1.example', 'wss://a2.example'],
        ['wss://b1.example', 'wss://b2.example']
      ]
    })

    const started = context.activation.start()
    await settle()
    await started

    expect(context.opened).toEqual([
      'wss://a1.example',
      'wss://b1.example',
      'wss://a2.example',
      'wss://b2.example'
    ])
  })

  it('keeps one live socket per tier and the tier’s rest dormant', async () => {
    const context = harness({
      tiers: [
        ['wss://a1.example', 'wss://a2.example'],
        ['wss://b1.example', 'wss://b2.example']
      ]
    })

    const started = context.activation.start()
    await settle()
    await started

    const snapshot = context.activation.snapshot()
    expect(snapshot.live).toEqual(['wss://a1.example', 'wss://b1.example'])
    expect(snapshot.dormant).toEqual(['wss://a2.example', 'wss://b2.example'])
  })

  it('keeps at most four endpoints live and the rest dormant', async () => {
    const context = harness({
      tiers: Array.from({ length: 6 }, (_value, index) => [
        `wss://tracker-${index}.example`
      ])
    })

    const started = context.activation.start()
    await settle()
    await started

    const snapshot = context.activation.snapshot()
    expect(snapshot.live).toHaveLength(WSS_ACTIVATION_LIMITS.maxLiveEndpoints)
    expect(snapshot.dormant).toEqual([
      'wss://tracker-4.example',
      'wss://tracker-5.example'
    ])
  })

  it('promotes a dormant endpoint when one refuses to connect', async () => {
    const context = harness({
      refuse: new Set(['wss://one.example']),
      tiers: [
        ['wss://one.example', 'wss://three.example'],
        ['wss://two.example']
      ]
    })

    const started = context.activation.start()
    await settle()
    await started

    expect(context.activation.snapshot().live).toEqual([
      'wss://two.example',
      'wss://three.example'
    ])
  })

  it('ignores endpoints that are not wss', async () => {
    const context = harness({
      tiers: [['https://tracker.example/announce', 'wss://ok.example']]
    })

    const started = context.activation.start()
    await settle()
    await started

    expect(context.opened).toEqual(['wss://ok.example'])
  })

  it('announces again on the interval the tracker asked for', async () => {
    const context = harness({ tiers: [['wss://one.example']] })
    const started = context.activation.start()
    await settle()
    await started
    const socket = context.sockets.get('wss://one.example')
    if (!socket) throw new Error('The endpoint never opened')
    expect(socket.sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(
      WSS_TRACKER_LIMITS.defaultIntervalSeconds * 1_000
    )
    await settle()

    expect(socket.sent.length).toBeGreaterThan(1)
    expect(JSON.parse(socket.sent[1] as string).event).toBeUndefined()
  })

  it('closes every endpoint and cancels its timer on stop', async () => {
    const context = harness()
    const started = context.activation.start()
    await settle()
    await started

    const stopping = context.activation.stop()
    // Every endpoint shares one terminate grace rather than serializing them.
    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.terminateGraceMs + 10)
    await stopping

    expect(context.activation.snapshot().live).toEqual([])
    for (const socket of context.sockets.values()) {
      expect(socket.closed).toBe(true)
      // The one bounded stopped attempt precedes the close.
      const last = socket.sent.at(-1)
      expect(JSON.parse(last as string)).toMatchObject({
        event: 'stopped',
        numwant: 0
      })
    }

    const sentAfterStop = [...context.sockets.values()].map(
      socket => socket.sent.length
    )
    await vi.advanceTimersByTimeAsync(
      WSS_TRACKER_LIMITS.defaultIntervalSeconds * 2_000
    )
    expect(
      [...context.sockets.values()].map(socket => socket.sent.length)
    ).toEqual(sentAfterStop)
  })

  it('retires an endpoint whose announce fails and promotes a dormant one', async () => {
    const urls = Array.from(
      { length: 5 },
      (_value, index) => `wss://tracker-${index}.example`
    )
    const context = harness({
      acceptLimits: new Map([[urls[0] as string, 1]]),
      tiers: urls.map(url => [url])
    })

    const started = context.activation.start()
    await settle()
    await started

    const broken = context.sockets.get(urls[0] as string)
    if (!broken) throw new Error('The endpoint never opened')
    expect(broken.sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(
      WSS_TRACKER_LIMITS.defaultIntervalSeconds * 1_000
    )
    await settle()

    const snapshot = context.activation.snapshot()
    expect(snapshot.live).not.toContain(urls[0])
    expect(snapshot.live).toContain(urls[4])
    expect(broken.closed).toBe(true)
    // The refused stopped attempt is made once and never retried.
    expect(broken.sent).toHaveLength(1)
  })

  it('awaits close and retirement before staging failover opens', async () => {
    const retired: string[] = []
    const context = harness({
      acceptLimits: new Map([['wss://one.example', 1]]),
      retire: url => retired.push(url),
      serialRetirement: true,
      tiers: [['wss://one.example', 'wss://two.example']]
    })
    const started = context.activation.start()
    await settle()
    await started

    await vi.advanceTimersByTimeAsync(
      WSS_TRACKER_LIMITS.defaultIntervalSeconds * 1_000
    )
    await settle()
    expect(context.opened).toEqual(['wss://one.example'])
    expect(retired).toEqual([])

    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.terminateGraceMs + 10)
    await settle()
    expect(retired).toEqual(['wss://one.example'])
    expect(context.opened).toEqual(['wss://one.example', 'wss://two.example'])
  })

  it('reports exhaustion only after serial WSS retirement', async () => {
    const order: string[] = []
    const context = harness({
      acceptLimits: new Map([['wss://one.example', 1]]),
      exhaust: () => order.push('exhausted'),
      retire: () => order.push('retired'),
      serialRetirement: true,
      tiers: [['wss://one.example']]
    })
    const started = context.activation.start()
    await settle()
    await started

    await vi.advanceTimersByTimeAsync(
      WSS_TRACKER_LIMITS.defaultIntervalSeconds * 1_000 +
        WSS_TRACKER_LIMITS.terminateGraceMs +
        10
    )
    await settle()

    expect(order).toEqual(['retired', 'exhausted'])
  })

  it('generates each endpoint’s offers against that endpoint', async () => {
    const context = harness()
    const started = context.activation.start()
    await settle()
    await started

    expect(context.offerEndpoints).toEqual([
      'wss://one.example',
      'wss://two.example'
    ])
  })

  it('answers a remote offer through the endpoint that carried it', async () => {
    const context = harness()
    const started = context.activation.start()
    await settle()
    await started

    const socket = context.sockets.get('wss://two.example')
    if (!socket) throw new Error('The endpoint never opened')
    socket.deliver({
      info_hash: INFO_HASH,
      offer: { sdp: sdp(), type: 'offer' },
      offer_id: 'o'.repeat(20),
      peer_id: REMOTE_PEER_ID
    })

    expect(context.offers).toHaveLength(1)
    expect(context.offers[0]?.trackerUrl).toBe('wss://two.example')

    context.respond({ offerId: 'o'.repeat(20), sdp: sdp() })

    const frame = JSON.parse(socket.sent.at(-1) as string) as {
      answer: { type: string }
      to_peer_id: string
    }
    expect(frame.answer.type).toBe('answer')
    expect(frame.to_peer_id).toBe(REMOTE_PEER_ID)
    // The other endpoint never carries another endpoint's answer.
    expect(context.sockets.get('wss://one.example')?.sent).toHaveLength(1)
  })

  it('opens nothing when the torrent has no wss tier', async () => {
    const context = harness({ tiers: [['https://tracker.example/announce']] })

    await context.activation.start()

    expect(context.activation.endpointCount).toBe(0)
    expect(context.opened).toEqual([])
  })
})
