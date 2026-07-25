import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WssTrackerEndpoint,
  WssTrackerError,
  WSS_TRACKER_LIMITS,
  type WssSocket
} from './wss-tracker'

const INFO_HASH = 'a'.repeat(20)
const PEER_ID = 'b'.repeat(20)
const REMOTE_PEER_ID = 'd'.repeat(20)

function sdp(address = '93.184.216.34'): string {
  return [
    'v=0',
    'o=- 1 1 IN IP4 0.0.0.0',
    's=-',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    `a=candidate:1 1 udp 1 ${address} 6881 typ host`
  ].join('\r\n')
}

class FakeSocket extends EventEmitter implements WssSocket {
  bufferedAmount = 0
  closed = false
  terminated = false
  readonly sent: string[] = []

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    this.sent.push(data)
  }

  terminate(): void {
    this.terminated = true
  }

  deliver(payload: unknown, isBinary = false): void {
    this.emit(
      'message',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      isBinary
    )
  }
}

type Harness = {
  answers: Array<{ offerId: string; peerId: string; sdp: string }>
  endpoint: WssTrackerEndpoint
  intervals: number[]
  offers: Array<{ offerId: string; peerId: string; sdp: string }>
  socket: FakeSocket
}

function createHarness(
  options: {
    allowPrivateNetwork?: boolean
    offerSdp?: string
    url?: string
  } = {}
): Harness {
  const socket = new FakeSocket()
  const answers: Harness['answers'] = []
  const offers: Harness['offers'] = []
  const intervals: number[] = []
  const endpoint = new WssTrackerEndpoint({
    allowPrivateNetwork: options.allowPrivateNetwork ?? false,
    createOffers: count =>
      Promise.resolve(
        Array.from({ length: count }, (_value, index) => ({
          offerId: `offer-${index}`.padEnd(20, '0'),
          sdp: options.offerSdp ?? sdp()
        }))
      ),
    createSocket: () => socket,
    infoHash: INFO_HASH,
    now: () => Date.now(),
    onAnswer: answer => answers.push(answer),
    onInterval: seconds => intervals.push(seconds),
    onOffer: offer => offers.push(offer),
    peerId: PEER_ID,
    trackerUrl: options.url ?? 'wss://tracker.example/announce'
  })
  return { answers, endpoint, intervals, offers, socket }
}

async function connected(harness: Harness): Promise<void> {
  const pending = harness.endpoint.connect()
  harness.socket.emit('open')
  await pending
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-24T12:00:00Z'))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('WssTrackerEndpoint', () => {
  it('refuses a cleartext WebSocket endpoint', async () => {
    const harness = createHarness({ url: 'ws://tracker.example/announce' })
    await expect(harness.endpoint.connect()).rejects.toMatchObject({
      code: 'TRANSPORT_DISABLED'
    })
  })

  it('fails closed when the upgrade misses its deadline', async () => {
    const harness = createHarness()
    const pending = harness.endpoint.connect()
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'CONNECT_TIMEOUT'
    })

    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.connectDeadlineMs)
    await rejection
    expect(harness.socket.terminated).toBe(true)
  })

  it('announces with at most five offers and a matching numwant', async () => {
    const harness = createHarness()
    await connected(harness)

    await harness.endpoint.announce({
      downloaded: 0,
      event: 'started',
      left: 1_024,
      numwant: 50,
      uploaded: 0
    })

    const frame = JSON.parse(harness.socket.sent[0] ?? '{}') as {
      event: string
      numwant: number
      offers: unknown[]
    }
    expect(frame.event).toBe('started')
    expect(frame.offers).toHaveLength(WSS_TRACKER_LIMITS.maxOffersPerAnnounce)
    expect(frame.numwant).toBe(WSS_TRACKER_LIMITS.maxOffersPerAnnounce)
    expect(harness.endpoint.pendingOfferCount).toBe(
      WSS_TRACKER_LIMITS.maxOffersPerAnnounce
    )
  })

  it('never advertises an offer with no usable candidate', async () => {
    const harness = createHarness({ offerSdp: sdp('10.0.0.4') })
    await connected(harness)

    await harness.endpoint.announce({
      downloaded: 0,
      left: 1_024,
      numwant: 5,
      uploaded: 0
    })

    const frame = JSON.parse(harness.socket.sent[0] ?? '{}') as {
      numwant: number
      offers: unknown[]
    }
    expect(frame.offers).toEqual([])
    expect(frame.numwant).toBe(0)
  })

  it('sends a stopped announce without offers', async () => {
    const harness = createHarness()
    await connected(harness)

    await harness.endpoint.announce({
      downloaded: 10,
      event: 'stopped',
      left: 0,
      numwant: 5,
      uploaded: 5
    })

    const frame = JSON.parse(harness.socket.sent[0] ?? '{}') as {
      event: string
      offers: unknown[]
    }
    expect(frame.event).toBe('stopped')
    expect(frame.offers).toEqual([])
  })

  it('accepts exactly one answer per offer identifier', async () => {
    const harness = createHarness()
    await connected(harness)
    await harness.endpoint.announce({
      downloaded: 0,
      left: 1_024,
      numwant: 1,
      uploaded: 0
    })
    const offerId = 'offer-0'.padEnd(20, '0')

    const answer = {
      answer: { sdp: sdp(), type: 'answer' },
      info_hash: INFO_HASH,
      offer_id: offerId,
      peer_id: REMOTE_PEER_ID
    }
    harness.socket.deliver(answer)
    harness.socket.deliver(answer)

    expect(harness.answers).toHaveLength(1)
    expect(harness.answers[0]).toMatchObject({ peerId: REMOTE_PEER_ID })
    expect(harness.endpoint.pendingOfferCount).toBe(0)

    harness.socket.deliver({
      answer: { sdp: sdp(), type: 'answer' },
      info_hash: INFO_HASH,
      offer_id: 'unknown'.padEnd(20, '0'),
      peer_id: REMOTE_PEER_ID
    })
    expect(harness.answers).toHaveLength(1)
  })

  it('drops an answer that arrives after its offer expires', async () => {
    const harness = createHarness()
    await connected(harness)
    await harness.endpoint.announce({
      downloaded: 0,
      left: 1_024,
      numwant: 1,
      uploaded: 0
    })

    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.answerTimeoutMs + 1)
    harness.socket.deliver({
      answer: { sdp: sdp(), type: 'answer' },
      info_hash: INFO_HASH,
      offer_id: 'offer-0'.padEnd(20, '0'),
      peer_id: REMOTE_PEER_ID
    })

    expect(harness.answers).toHaveLength(0)
  })

  it('ignores a signal that echoes this client peer id', async () => {
    const harness = createHarness()
    await connected(harness)

    harness.socket.deliver({
      info_hash: INFO_HASH,
      offer: { sdp: sdp(), type: 'offer' },
      offer_id: 'x'.repeat(20),
      peer_id: PEER_ID
    })

    expect(harness.offers).toHaveLength(0)
  })

  it('records the tracker interval and its endpoint-local identifier', async () => {
    const harness = createHarness()
    await connected(harness)

    harness.socket.deliver({
      info_hash: INFO_HASH,
      interval: 300,
      'tracker id': 'endpoint-local'
    })
    harness.socket.deliver({ info_hash: INFO_HASH })

    expect(harness.intervals).toEqual([
      300,
      WSS_TRACKER_LIMITS.defaultIntervalSeconds
    ])

    await harness.endpoint.announce({
      downloaded: 0,
      left: 1,
      numwant: 0,
      uploaded: 0
    })
    expect(harness.socket.sent.at(-1)).toContain('endpoint-local')
  })

  it('quarantines a binary frame, a wrong info hash, and a malformed frame', async () => {
    for (const deliver of [
      (harness: Harness): void => harness.socket.deliver('payload', true),
      (harness: Harness): void =>
        harness.socket.deliver({ info_hash: 'z'.repeat(20) }),
      (harness: Harness): void => harness.socket.deliver('{not json')
    ]) {
      const harness = createHarness()
      await connected(harness)
      deliver(harness)

      expect(harness.endpoint.quarantined).toBe(true)
      expect(harness.socket.terminated).toBe(true)
      await expect(
        harness.endpoint.announce({
          downloaded: 0,
          left: 1,
          numwant: 1,
          uploaded: 0
        })
      ).rejects.toBeInstanceOf(WssTrackerError)
    }
  })

  it('quarantines a socket that floods signalling', async () => {
    const harness = createHarness()
    await connected(harness)

    for (
      let index = 0;
      index <= WSS_TRACKER_LIMITS.maxSignalsPerMinute;
      index += 1
    ) {
      harness.socket.deliver({
        info_hash: INFO_HASH,
        offer: { sdp: sdp(), type: 'offer' },
        offer_id: `flood-${index}`.padEnd(20, '0'),
        peer_id: REMOTE_PEER_ID
      })
    }

    expect(harness.offers).toHaveLength(WSS_TRACKER_LIMITS.maxSignalsPerMinute)
    expect(harness.endpoint.quarantined).toBe(true)
  })

  it('quarantines when the outbound queue exceeds its ceiling', async () => {
    const harness = createHarness()
    await connected(harness)
    harness.socket.bufferedAmount =
      WSS_TRACKER_LIMITS.maxQueuedOutboundBytes + 1

    await expect(
      harness.endpoint.announce({
        downloaded: 0,
        left: 1,
        numwant: 0,
        uploaded: 0
      })
    ).rejects.toMatchObject({ code: 'QUARANTINED' })
    expect(harness.endpoint.quarantined).toBe(true)
  })

  it('probes an idle socket and reports a missing pong', async () => {
    const harness = createHarness()
    await connected(harness)

    expect(harness.endpoint.heartbeat()).toBe('idle')
    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.heartbeatIdleMs)
    expect(harness.endpoint.heartbeat()).toBe('probed')
    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.heartbeatPongMs + 1)
    expect(harness.endpoint.heartbeat()).toBe('failed')
  })

  it('closes normally and force-terminates after the grace', async () => {
    const harness = createHarness()
    await connected(harness)

    const closing = harness.endpoint.close()
    expect(harness.socket.closed).toBe(true)
    expect(harness.socket.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(WSS_TRACKER_LIMITS.terminateGraceMs)
    await closing
    expect(harness.socket.terminated).toBe(true)
    expect(harness.endpoint.connected).toBe(false)
    await harness.endpoint.close()
  })
})
