import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PendingSignalingBudget,
  WEBRTC_SIGNALING_LIMITS,
  WebrtcSignaling,
  type SignalingPeer
} from './webrtc-signaling'

const REMOTE_PEER_ID = 'r'.repeat(20)
const LOCAL_PEER_ID = 'l'.repeat(20)

class FakePeer extends EventEmitter implements SignalingPeer {
  destroyed = false
  id?: string
  readonly initiator: boolean
  readonly signaled: unknown[] = []

  constructor(initiator: boolean) {
    super()
    this.initiator = initiator
  }

  destroy(): void {
    this.destroyed = true
  }

  signal(description: unknown): void {
    this.signaled.push(description)
  }

  /** Mimics the local description simple-peer emits once ICE completes. */
  describe(type: 'answer' | 'offer'): void {
    this.emit('signal', { sdp: `v=0 ${type}`, type })
  }
}

type Harness = {
  handoffs: Array<{ peer: SignalingPeer; peerId: string }>
  peers: FakePeer[]
  signaling: WebrtcSignaling
}

function harness(
  options: {
    admit?: boolean
    budget?: PendingSignalingBudget
    describeOffers?: boolean
  } = {}
): Harness {
  const peers: FakePeer[] = []
  const handoffs: Array<{ peer: SignalingPeer; peerId: string }> = []

  const signaling = new WebrtcSignaling({
    createPeer: ({ initiator }) => {
      const peer = new FakePeer(initiator)
      peers.push(peer)
      if (initiator && options.describeOffers !== false) {
        // The real peer emits its description asynchronously.
        setTimeout(() => peer.describe('offer'), 0)
      }
      return peer
    },
    handoff: (peer, peerId) => {
      handoffs.push({ peer, peerId })
      return options.admit ?? true
    },
    isSelfPeerId: peerId => peerId === LOCAL_PEER_ID,
    pending: options.budget ?? new PendingSignalingBudget()
  })

  return { handoffs, peers, signaling }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

/** Offer descriptions arrive on a later turn, as they do with a real peer. */
async function withTimers<T>(pending: Promise<T>): Promise<T> {
  await settle()
  return pending
}

describe('WebrtcSignaling', () => {
  it('generates one distinct offer per requested slot', async () => {
    const context = harness()

    const offers = await withTimers(
      context.signaling.createOffers(3, 'wss://a.example')
    )

    expect(offers).toHaveLength(3)
    expect(new Set(offers.map(offer => offer.offerId)).size).toBe(3)
    for (const offer of offers) {
      expect(offer.offerId).toHaveLength(WEBRTC_SIGNALING_LIMITS.offerIdBytes)
      expect(offer.sdp).toBe('v=0 offer')
    }
    expect(context.signaling.leaseCount).toBe(3)
  })

  it('never exceeds the pending budget for one endpoint', async () => {
    const context = harness()

    const offers = await withTimers(
      context.signaling.createOffers(5, 'wss://a.example')
    )
    const more = await withTimers(
      context.signaling.createOffers(5, 'wss://a.example')
    )

    expect(offers).toHaveLength(WEBRTC_SIGNALING_LIMITS.maxPendingPerEndpoint)
    expect(more).toHaveLength(0)
  })

  it('never exceeds the pending budget for one torrent', async () => {
    const context = harness()

    await withTimers(context.signaling.createOffers(5, 'wss://a.example'))
    await withTimers(context.signaling.createOffers(5, 'wss://b.example'))
    await withTimers(context.signaling.createOffers(5, 'wss://c.example'))

    expect(context.signaling.leaseCount).toBe(
      WEBRTC_SIGNALING_LIMITS.maxPendingPerTorrent
    )
  })

  it('shares the engine-wide pending budget across torrents', async () => {
    const budget = new PendingSignalingBudget()
    const first = harness({ budget })
    const second = harness({ budget })
    const third = harness({ budget })
    const fourth = harness({ budget })

    await withTimers(first.signaling.createOffers(5, 'wss://a.example'))
    await withTimers(second.signaling.createOffers(5, 'wss://b.example'))
    await withTimers(third.signaling.createOffers(5, 'wss://c.example'))
    const starved = await withTimers(
      fourth.signaling.createOffers(5, 'wss://d.example')
    )

    expect(budget.live).toBe(WEBRTC_SIGNALING_LIMITS.maxPendingEngineWide)
    // The fourth torrent receives only the slot the engine-wide cap leaves.
    expect(starved).toHaveLength(
      WEBRTC_SIGNALING_LIMITS.maxPendingEngineWide -
        WEBRTC_SIGNALING_LIMITS.maxPendingPerEndpoint * 3
    )
  })

  it('abandons an offer whose description never arrives', async () => {
    const context = harness({ describeOffers: false })

    const pending = context.signaling.createOffers(2, 'wss://a.example')
    await vi.advanceTimersByTimeAsync(
      WEBRTC_SIGNALING_LIMITS.offerTimeoutMs + 10
    )

    expect(await pending).toHaveLength(0)
    expect(context.signaling.leaseCount).toBe(0)
    expect(context.peers.every(peer => peer.destroyed)).toBe(true)
  })

  it('drops an offer that is never answered', async () => {
    const context = harness()

    await withTimers(context.signaling.createOffers(1, 'wss://a.example'))
    expect(context.signaling.pendingCount).toBe(1)

    await vi.advanceTimersByTimeAsync(
      WEBRTC_SIGNALING_LIMITS.answerTimeoutMs + 10
    )

    expect(context.signaling.pendingCount).toBe(0)
    expect(context.signaling.leaseCount).toBe(0)
    expect(context.peers[0]?.destroyed).toBe(true)
  })

  it('hands off a peer that connects after its answer', async () => {
    const context = harness()
    const [offer] = await withTimers(
      context.signaling.createOffers(1, 'wss://a.example')
    )
    if (!offer) throw new Error('The offer was never generated')

    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })
    const peer = context.peers[0]
    expect(peer?.signaled).toEqual([{ sdp: 'v=0 answer', type: 'answer' }])
    expect(peer?.id).toBe(REMOTE_PEER_ID)

    peer?.emit('connect')

    expect(context.handoffs).toEqual([{ peer, peerId: REMOTE_PEER_ID }])
    // The transport is now WebTorrent's; the signaling lease is released.
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('destroys a peer the torrent refuses at handoff', async () => {
    const context = harness({ admit: false })
    const [offer] = await withTimers(
      context.signaling.createOffers(1, 'wss://a.example')
    )
    if (!offer) throw new Error('The offer was never generated')

    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })
    context.peers[0]?.emit('connect')

    expect(context.peers[0]?.destroyed).toBe(true)
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('destroys a signaled peer that never connects in time', async () => {
    const context = harness()
    const [offer] = await withTimers(
      context.signaling.createOffers(1, 'wss://a.example')
    )
    if (!offer) throw new Error('The offer was never generated')

    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })
    await vi.advanceTimersByTimeAsync(
      WEBRTC_SIGNALING_LIMITS.connectTimeoutMs + 10
    )

    expect(context.handoffs).toEqual([])
    expect(context.peers[0]?.destroyed).toBe(true)
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('creates no peer for a duplicate, late, or unknown answer', async () => {
    const context = harness()
    const [offer] = await withTimers(
      context.signaling.createOffers(1, 'wss://a.example')
    )
    if (!offer) throw new Error('The offer was never generated')

    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })
    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })
    context.signaling.acceptAnswer({
      offerId: 'z'.repeat(20),
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })

    expect(context.peers).toHaveLength(1)
    expect(context.peers[0]?.signaled).toHaveLength(1)
  })

  it('refuses an answer carrying a local peer identity', async () => {
    const context = harness()
    const [offer] = await withTimers(
      context.signaling.createOffers(1, 'wss://a.example')
    )
    if (!offer) throw new Error('The offer was never generated')

    context.signaling.acceptAnswer({
      offerId: offer.offerId,
      peerId: LOCAL_PEER_ID,
      sdp: 'v=0 answer'
    })

    expect(context.peers[0]?.signaled).toEqual([])
    expect(context.peers[0]?.destroyed).toBe(true)
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('answers a remote offer and hands off the connected peer', async () => {
    const context = harness()
    const answers: Array<{ offerId: string; sdp: string }> = []

    context.signaling.acceptOffer(
      { offerId: 'o'.repeat(20), peerId: REMOTE_PEER_ID, sdp: 'v=0 offer' },
      'wss://a.example',
      answer => answers.push({ ...answer })
    )
    const peer = context.peers[0]
    expect(peer?.initiator).toBe(false)
    expect(peer?.signaled).toEqual([{ sdp: 'v=0 offer', type: 'offer' }])

    peer?.describe('answer')
    expect(answers).toEqual([{ offerId: 'o'.repeat(20), sdp: 'v=0 answer' }])

    peer?.emit('connect')
    expect(context.handoffs).toEqual([{ peer, peerId: REMOTE_PEER_ID }])
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('never answers an offer carrying a local peer identity', () => {
    const context = harness()

    context.signaling.acceptOffer(
      { offerId: 'o'.repeat(20), peerId: LOCAL_PEER_ID, sdp: 'v=0 offer' },
      'wss://a.example',
      () => {
        throw new Error('A local peer identity must never be answered')
      }
    )

    expect(context.peers).toHaveLength(0)
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('drops a remote offer that is never answered in time', async () => {
    const context = harness()

    context.signaling.acceptOffer(
      { offerId: 'o'.repeat(20), peerId: REMOTE_PEER_ID, sdp: 'v=0 offer' },
      'wss://a.example',
      () => undefined
    )
    await vi.advanceTimersByTimeAsync(
      WEBRTC_SIGNALING_LIMITS.offerTimeoutMs + 10
    )

    expect(context.peers[0]?.destroyed).toBe(true)
    expect(context.signaling.leaseCount).toBe(0)
  })

  it('destroys every unfinished peer and frees its lease on close', async () => {
    const budget = new PendingSignalingBudget()
    const context = harness({ budget })
    const offers = await withTimers(
      context.signaling.createOffers(3, 'wss://a.example')
    )
    const [first] = offers
    if (!first) throw new Error('The offer was never generated')
    // One peer is past signaling and still connecting.
    context.signaling.acceptAnswer({
      offerId: first.offerId,
      peerId: REMOTE_PEER_ID,
      sdp: 'v=0 answer'
    })

    context.signaling.close()

    expect(context.peers.every(peer => peer.destroyed)).toBe(true)
    expect(context.signaling.leaseCount).toBe(0)
    expect(budget.live).toBe(0)
    await settle()
    expect(context.handoffs).toEqual([])
  })

  it('generates nothing once it is closed', async () => {
    const context = harness()
    context.signaling.close()

    expect(
      await withTimers(context.signaling.createOffers(3, 'wss://a.example'))
    ).toEqual([])
    expect(context.peers).toHaveLength(0)
  })
})
