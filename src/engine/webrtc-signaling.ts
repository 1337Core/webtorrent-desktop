import { randomBytes } from 'node:crypto'

export const WEBRTC_SIGNALING_LIMITS = Object.freeze({
  /** A generated offer waits this long for its one answer. */
  answerTimeoutMs: 50_000,
  /** A signaled peer must finish its WebRTC connection inside this budget. */
  connectTimeoutMs: 25_000,
  /** Pending signaling for one tracker endpoint. */
  maxPendingPerEndpoint: 5,
  /** Pending signaling engine-wide, across every torrent and endpoint. */
  maxPendingEngineWide: 16,
  /** Pending signaling for one torrent. */
  maxPendingPerTorrent: 8,
  /** Local offer or answer generation, from creation to its description. */
  offerTimeoutMs: 10_000,
  offerIdBytes: 20
} as const)

/** The exact `@thaunknown/simple-peer` surface this engine uses. */
export type SignalingPeer = {
  destroy(): void
  id?: string
  on(event: string, listener: (...args: unknown[]) => void): unknown
  signal(description: unknown): void
}

type SignalingDescription = Readonly<{
  sdp: string
  type: 'answer' | 'offer'
}>

export type WebrtcSignalingOptions = Readonly<{
  /**
   * Builds one peer with the engine's fixed RTC configuration. Tracker
   * messages never contribute to it.
   */
  createPeer: (input: Readonly<{ initiator: boolean }>) => SignalingPeer
  /**
   * Hands a connected peer to its torrent. A refused handoff destroys the
   * peer, so admission stays with the caller.
   */
  handoff: (peer: SignalingPeer, peerId: string) => boolean
  /** True for any peer ID belonging to an active local client. */
  isSelfPeerId: (peerId: string) => boolean
  /** Shared across every torrent so the engine-wide cap is real. */
  pending: PendingSignalingBudget
}>

/** The engine-wide pending-signaling budget, shared by every torrent. */
export class PendingSignalingBudget {
  #live = 0

  get live(): number {
    return this.#live
  }

  acquire(): boolean {
    if (this.#live >= WEBRTC_SIGNALING_LIMITS.maxPendingEngineWide) return false
    this.#live += 1
    return true
  }

  release(): void {
    if (this.#live > 0) this.#live -= 1
  }
}

type PendingPeer = {
  endpoint: string
  offerId: string
  peer: SignalingPeer
  released: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function offerIdentity(): string {
  return randomBytes(WEBRTC_SIGNALING_LIMITS.offerIdBytes).toString('latin1')
}

/**
 * One torrent's WebRTC signaling.
 *
 * Every peer here is unconnected: it exists only between an offer or answer
 * and the moment WebTorrent accepts the connected transport. Each holds a
 * pending-signaling lease that is released exactly once, whether it is handed
 * off, times out, fails, or is closed with the torrent.
 */
export class WebrtcSignaling {
  readonly #options: WebrtcSignalingOptions
  readonly #pending = new Map<string, PendingPeer>()
  /** Every peer of this torrent still holding a signaling lease. */
  readonly #leased = new Set<PendingPeer>()
  #closed = false

  constructor(options: WebrtcSignalingOptions) {
    this.#options = options
  }

  get pendingCount(): number {
    return this.#pending.size
  }

  /** Peers of this torrent still holding a signaling lease. */
  get leaseCount(): number {
    return this.#leased.size
  }

  /**
   * Generates at most as many offers as every applicable budget allows, so the
   * caller's `numwant` can match the offers that actually exist.
   */
  async createOffers(
    count: number,
    endpoint: string
  ): Promise<ReadonlyArray<Readonly<{ offerId: string; sdp: string }>>> {
    const allowed = this.#allowance(count, endpoint)
    const offers = await Promise.all(
      Array.from({ length: allowed }, () => this.#createOffer(endpoint))
    )
    return offers.filter(offer => offer !== null)
  }

  /**
   * Completes one generated offer. The endpoint has already consumed the offer
   * identifier, so a late, duplicate, or replayed answer finds nothing here.
   */
  acceptAnswer(
    answer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ): void {
    const entry = this.#pending.get(answer.offerId)
    if (!entry) return
    this.#pending.delete(answer.offerId)
    if (entry.timer) clearTimeout(entry.timer)

    if (this.#closed || this.#options.isSelfPeerId(answer.peerId)) {
      this.#discard(entry)
      return
    }

    entry.peer.id = answer.peerId
    this.#awaitConnection(entry, answer.peerId)
    try {
      entry.peer.signal({ sdp: answer.sdp, type: 'answer' })
    } catch {
      this.#discard(entry)
    }
  }

  /**
   * Answers one remote offer. The answer is returned through `respond` only
   * while the peer is still pending, and never for a local peer ID.
   */
  acceptOffer(
    offer: Readonly<{ offerId: string; peerId: string; sdp: string }>,
    endpoint: string,
    respond: (answer: Readonly<{ offerId: string; sdp: string }>) => void
  ): void {
    if (this.#closed) return
    if (this.#options.isSelfPeerId(offer.peerId)) return
    if (this.#allowance(1, endpoint) < 1) return
    if (!this.#options.pending.acquire()) return

    const peer = this.#options.createPeer({ initiator: false })
    const entry: PendingPeer = {
      endpoint,
      offerId: offer.offerId,
      peer,
      released: false,
      timer: null
    }
    this.#leased.add(entry)
    // Inbound offers are keyed by the remote identifier, which never collides
    // with a locally generated one; a repeat replaces nothing.
    const key = `remote:${offer.offerId}:${offer.peerId}`
    if (this.#pending.has(key)) {
      this.#release(entry)
      peer.destroy()
      return
    }
    this.#pending.set(key, entry)

    peer.id = offer.peerId
    let answered = false
    peer.on('signal', (...args: unknown[]) => {
      const description = args[0]
      if (answered || !isDescription(description, 'answer')) return
      answered = true
      if (this.#pending.get(key) !== entry) return
      this.#pending.delete(key)
      if (entry.timer) clearTimeout(entry.timer)
      this.#awaitConnection(entry, offer.peerId)
      respond({ offerId: offer.offerId, sdp: description.sdp })
    })
    peer.on('error', () => {
      if (this.#pending.get(key) === entry) this.#pending.delete(key)
      this.#discard(entry)
    })
    entry.timer = this.#deadline(() => {
      if (this.#pending.get(key) !== entry) return
      this.#pending.delete(key)
      this.#discard(entry)
    }, WEBRTC_SIGNALING_LIMITS.offerTimeoutMs)

    try {
      peer.signal({ sdp: offer.sdp, type: 'offer' })
    } catch {
      this.#pending.delete(key)
      this.#discard(entry)
    }
  }

  /** Destroys every peer that never reached a torrent and frees its lease. */
  close(): void {
    this.#closed = true
    this.#pending.clear()
    for (const entry of [...this.#leased]) {
      if (entry.timer) clearTimeout(entry.timer)
      this.#discard(entry)
    }
  }

  /** Retires every pending/connecting peer attributable to one endpoint. */
  retireEndpoint(endpoint: string): void {
    for (const entry of [...this.#leased]) {
      if (entry.endpoint !== endpoint) continue
      for (const [key, pending] of this.#pending) {
        if (pending === entry) this.#pending.delete(key)
      }
      if (entry.timer) clearTimeout(entry.timer)
      this.#discard(entry)
    }
  }

  /**
   * Every budget counts leases, not map entries: a peer that is signaled and
   * still connecting has left the pending map but has not yet reached a
   * torrent, so it keeps occupying its slot.
   */
  #allowance(count: number, endpoint: string): number {
    if (this.#closed || !Number.isSafeInteger(count) || count < 1) return 0
    let perEndpoint = 0
    for (const entry of this.#leased) {
      if (entry.endpoint === endpoint) perEndpoint += 1
    }
    return Math.max(
      0,
      Math.min(
        count,
        WEBRTC_SIGNALING_LIMITS.maxPendingPerEndpoint - perEndpoint,
        WEBRTC_SIGNALING_LIMITS.maxPendingPerTorrent - this.#leased.size,
        WEBRTC_SIGNALING_LIMITS.maxPendingEngineWide -
          this.#options.pending.live
      )
    )
  }

  async #createOffer(
    endpoint: string
  ): Promise<Readonly<{ offerId: string; sdp: string }> | null> {
    if (!this.#options.pending.acquire()) return null

    const offerId = offerIdentity()
    const peer = this.#options.createPeer({ initiator: true })
    const entry: PendingPeer = {
      endpoint,
      offerId,
      peer,
      released: false,
      timer: null
    }
    this.#leased.add(entry)

    const description = await new Promise<string | null>(resolve => {
      let settled = false
      const finish = (sdp: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(sdp)
      }
      const timer = setTimeout(
        () => finish(null),
        WEBRTC_SIGNALING_LIMITS.offerTimeoutMs
      )
      timer.unref?.()
      peer.on('signal', (...args: unknown[]) => {
        const value = args[0]
        if (isDescription(value, 'offer')) finish(value.sdp)
      })
      peer.on('error', () => finish(null))
    })

    if (description === null || this.#closed) {
      this.#discard(entry)
      return null
    }

    this.#pending.set(offerId, entry)
    entry.timer = this.#deadline(() => {
      if (this.#pending.get(offerId) !== entry) return
      this.#pending.delete(offerId)
      this.#discard(entry)
    }, WEBRTC_SIGNALING_LIMITS.answerTimeoutMs)
    return { offerId, sdp: description }
  }

  /**
   * A signaled peer has one bounded chance to connect. Only a connected peer
   * is handed off, and the lease is released either way.
   */
  #awaitConnection(entry: PendingPeer, peerId: string): void {
    const timer = this.#deadline(() => {
      this.#discard(entry)
    }, WEBRTC_SIGNALING_LIMITS.connectTimeoutMs)

    entry.peer.on('connect', () => {
      clearTimeout(timer)
      if (entry.released) return
      if (this.#closed || !this.#options.handoff(entry.peer, peerId)) {
        this.#discard(entry)
        return
      }
      // The transport now belongs to WebTorrent's own peer budget.
      this.#release(entry)
    })
    entry.peer.on('error', () => {
      clearTimeout(timer)
      this.#discard(entry)
    })
    entry.peer.on('close', () => {
      clearTimeout(timer)
      this.#discard(entry)
    })
  }

  #deadline(run: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(run, delayMs)
    timer.unref?.()
    return timer
  }

  /** Destroys a peer that never reached a torrent and frees its lease once. */
  #discard(entry: PendingPeer): void {
    if (entry.released) return
    this.#release(entry)
    try {
      entry.peer.destroy()
    } catch {
      // A peer that refuses to be destroyed still gives up its lease.
    }
  }

  #release(entry: PendingPeer): void {
    if (entry.released) return
    entry.released = true
    this.#leased.delete(entry)
    this.#options.pending.release()
  }
}

function isDescription(
  value: unknown,
  type: 'answer' | 'offer'
): value is SignalingDescription {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === type &&
    typeof (value as { sdp?: unknown }).sdp === 'string'
  )
}
