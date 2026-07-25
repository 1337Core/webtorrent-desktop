import { randomBytes } from 'node:crypto'
import {
  filterIceCandidates,
  parseWssMessage,
  WssMessageError,
  type WssInboundMessage
} from './wss-message'

export const WSS_TRACKER_LIMITS = Object.freeze({
  announceDeadlineMs: 15_000,
  answerTimeoutMs: 50_000,
  connectDeadlineMs: 15_000,
  defaultIntervalSeconds: 120,
  heartbeatIdleMs: 30_000,
  heartbeatPongMs: 10_000,
  maxOffersPerAnnounce: 5,
  maxQueuedOutboundBytes: 262_144,
  maxSignalsPerMinute: 20,
  offerTimeoutMs: 10_000,
  terminateGraceMs: 1_000
})

export type WssTrackerErrorCode =
  | 'CONNECT_FAILED'
  | 'CONNECT_TIMEOUT'
  | 'QUARANTINED'
  | 'TRACKER_FAILURE'
  | 'TRANSPORT_DISABLED'

export class WssTrackerError extends Error {
  readonly code: WssTrackerErrorCode

  constructor(code: WssTrackerErrorCode) {
    super(`Tracker WSS endpoint failed: ${code}.`)
    this.name = 'WssTrackerError'
    this.code = code
  }
}

/** The exact `ws` surface this transport uses. */
export type WssSocket = {
  close(code?: number, reason?: string): void
  readonly bufferedAmount: number
  on(event: string, listener: (...args: unknown[]) => void): unknown
  send(data: string): void
  terminate(): void
}

type WssAnnounceEvent = 'completed' | 'started' | 'stopped'

export type WssAnnounceInput = Readonly<{
  downloaded: number
  event?: WssAnnounceEvent
  left: number
  numwant: number
  uploaded: number
}>

export type WssOfferDescription = Readonly<{ offerId: string; sdp: string }>

export type WssTrackerOptions = Readonly<{
  allowPrivateNetwork: boolean
  /** Only `wss:` is ever accepted; cleartext WebSocket trackers are disabled. */
  createSocket: (url: string) => WssSocket
  /** One bounded offer per requested slot, already SDP-validated. */
  createOffers: (count: number) => Promise<ReadonlyArray<WssOfferDescription>>
  infoHash: string
  now?: () => number
  onAnswer: (
    answer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  onOffer?: (
    offer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  onInterval?: (seconds: number) => void
  onFailure?: (error: WssTrackerError) => void
  peerId: string
  trackerUrl: string
}>

type PendingOffer = { expiresAtMs: number; offerId: string }
type PendingAnnounce = {
  reject: (error: WssTrackerError) => void
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One isolated, nonredirecting socket for a single torrent and endpoint.
 *
 * There is no pooling, compression, ambient credential, `Origin`, or
 * autonomous reconnect: a closed endpoint stays closed until the scheduler
 * activates it again.
 */
export class WssTrackerEndpoint {
  readonly #allowPrivateNetwork: boolean
  readonly #createOffers: (
    count: number
  ) => Promise<ReadonlyArray<WssOfferDescription>>
  readonly #createSocket: (url: string) => WssSocket
  readonly #infoHash: string
  readonly #now: () => number
  readonly #onAnswer: WssTrackerOptions['onAnswer']
  readonly #onFailure: (error: WssTrackerError) => void
  readonly #onInterval: (seconds: number) => void
  readonly #onOffer: (
    offer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  readonly #peerId: string
  readonly #pendingOffers = new Map<string, PendingOffer>()
  readonly #signalTimestamps: number[] = []
  readonly #trackerUrl: string
  #closed = false
  #didConnect = false
  #heartbeatNonce: string | null = null
  #lastInboundMs = 0
  #failureNotified = false
  #pendingAnnounce: PendingAnnounce | null = null
  #quarantined = false
  #socket: WssSocket | null = null
  #trackerId: string | null = null

  constructor(options: WssTrackerOptions) {
    this.#allowPrivateNetwork = options.allowPrivateNetwork
    this.#createOffers = options.createOffers
    this.#createSocket = options.createSocket
    this.#infoHash = options.infoHash
    this.#now = options.now ?? (() => Date.now())
    this.#onAnswer = options.onAnswer
    this.#onFailure = options.onFailure ?? (() => undefined)
    this.#onInterval = options.onInterval ?? (() => undefined)
    this.#onOffer = options.onOffer ?? (() => undefined)
    this.#peerId = options.peerId
    this.#trackerUrl = options.trackerUrl
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#closed
  }

  get quarantined(): boolean {
    return this.#quarantined
  }

  get pendingOfferCount(): number {
    this.#expireOffers()
    return this.#pendingOffers.size
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new WssTrackerError('TRANSPORT_DISABLED')
    if (this.#socket) return
    if (!this.#trackerUrl.startsWith('wss://')) {
      throw new WssTrackerError('TRANSPORT_DISABLED')
    }

    const socket = this.#createSocket(this.#trackerUrl)
    this.#socket = socket
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error: WssTrackerError | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        const error = new WssTrackerError('CONNECT_TIMEOUT')
        try {
          socket.terminate()
        } finally {
          this.#transportFailed(socket, error)
          finish(error)
        }
      }, WSS_TRACKER_LIMITS.connectDeadlineMs)
      timer.unref()

      socket.on('open', () => finish(null))
      socket.on('error', () => {
        const error = new WssTrackerError('CONNECT_FAILED')
        this.#transportFailed(socket, error)
        finish(error)
      })
      socket.on('close', () => {
        const error = new WssTrackerError('CONNECT_FAILED')
        this.#transportFailed(socket, error)
        finish(error)
      })
      socket.on('message', (...args: unknown[]) => {
        this.#receive(args[0], args[1])
      })
    })

    this.#didConnect = true
    this.#lastInboundMs = this.#now()
  }

  /**
   * One announce frame with at most five offers. `numwant` always matches the
   * number of offers actually generated.
   */
  async announce(input: WssAnnounceInput): Promise<void> {
    const socket = this.#socket
    if (!socket || this.#closed || this.#quarantined) {
      throw new WssTrackerError('TRANSPORT_DISABLED')
    }

    const requested = Math.max(
      0,
      Math.min(input.numwant, WSS_TRACKER_LIMITS.maxOffersPerAnnounce)
    )
    const offers =
      input.event === 'stopped' || requested === 0
        ? []
        : (await this.#createOffers(requested)).slice(
            0,
            WSS_TRACKER_LIMITS.maxOffersPerAnnounce
          )

    const usable: Array<{
      offer_id: string
      offer: { sdp: string; type: 'offer' }
    }> = []
    for (const offer of offers) {
      let sdp: string
      try {
        // Local host candidates are filtered before advertisement, so a
        // private address is never disclosed without the torrent's grant.
        sdp = filterIceCandidates(offer.sdp, {
          allowPrivateNetwork: this.#allowPrivateNetwork
        })
      } catch {
        continue
      }
      this.#pendingOffers.set(offer.offerId, {
        expiresAtMs: this.#now() + WSS_TRACKER_LIMITS.answerTimeoutMs,
        offerId: offer.offerId
      })
      usable.push({ offer: { sdp, type: 'offer' }, offer_id: offer.offerId })
    }

    const waitForResponse =
      input.event === 'stopped' ? null : this.#expectAnnounceResponse()
    try {
      this.#send({
        action: 'announce',
        downloaded: input.downloaded,
        info_hash: this.#infoHash,
        left: input.left,
        numwant: usable.length,
        offers: usable,
        peer_id: this.#peerId,
        uploaded: input.uploaded,
        ...(input.event ? { event: input.event } : {}),
        ...(this.#trackerId === null ? {} : { 'tracker id': this.#trackerId })
      })
    } catch (cause) {
      const error =
        cause instanceof WssTrackerError
          ? cause
          : new WssTrackerError('CONNECT_FAILED')
      this.#rejectPendingAnnounce(error)
      await waitForResponse?.catch(() => undefined)
      throw error
    }
    await waitForResponse
  }

  /**
   * Returns this client's answer for one remote offer. The answer carries the
   * same candidate filtering as an outgoing offer, so a refused SDP is dropped
   * rather than disclosed.
   */
  answer(
    input: Readonly<{ offerId: string; sdp: string; toPeerId: string }>
  ): void {
    if (!this.#socket || this.#closed || this.#quarantined) {
      throw new WssTrackerError('TRANSPORT_DISABLED')
    }

    const sdp = filterIceCandidates(input.sdp, {
      allowPrivateNetwork: this.#allowPrivateNetwork
    })
    this.#send({
      action: 'announce',
      answer: { sdp, type: 'answer' },
      info_hash: this.#infoHash,
      offer_id: input.offerId,
      peer_id: this.#peerId,
      to_peer_id: input.toPeerId,
      ...(this.#trackerId === null ? {} : { 'tracker id': this.#trackerId })
    })
  }

  /** Idle sockets are probed; a missing pong is a heartbeat failure. */
  heartbeat(): 'failed' | 'idle' | 'probed' {
    if (!this.#socket || this.#closed) return 'failed'
    const now = this.#now()

    if (this.#heartbeatNonce !== null) {
      return now - this.#lastInboundMs > WSS_TRACKER_LIMITS.heartbeatPongMs
        ? 'failed'
        : 'probed'
    }
    if (now - this.#lastInboundMs < WSS_TRACKER_LIMITS.heartbeatIdleMs) {
      return 'idle'
    }

    this.#heartbeatNonce = randomBytes(8).toString('hex')
    this.#socket.on('pong', () => {
      this.#heartbeatNonce = null
      this.#lastInboundMs = this.#now()
    })
    return 'probed'
  }

  /** Cancels timers, drops unhanded offers, closes, then force-terminates. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#pendingOffers.clear()
    this.#rejectPendingAnnounce(new WssTrackerError('TRANSPORT_DISABLED'))

    const socket = this.#socket
    this.#socket = null
    if (!socket) return

    try {
      socket.close(1_000, 'shutdown')
    } catch {
      // A socket that refuses a normal close is terminated below.
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try {
          socket.terminate()
        } catch {
          // Nothing further can be done for an already dead socket.
        }
        resolve()
      }, WSS_TRACKER_LIMITS.terminateGraceMs)
      timer.unref()
    })
  }

  #send(payload: Record<string, unknown>): void {
    const socket = this.#socket
    if (!socket) throw new WssTrackerError('TRANSPORT_DISABLED')
    if (socket.bufferedAmount > WSS_TRACKER_LIMITS.maxQueuedOutboundBytes) {
      this.#quarantine()
      throw new WssTrackerError('QUARANTINED')
    }
    socket.send(JSON.stringify(payload))
  }

  #receive(data: unknown, isBinary: unknown): void {
    if (this.#closed || this.#quarantined) return
    // Text frames only: a binary frame is a protocol violation.
    if (isBinary === true || typeof data !== 'string') {
      this.#quarantine()
      return
    }
    this.#lastInboundMs = this.#now()

    let message: WssInboundMessage
    try {
      message = parseWssMessage(data)
    } catch (error) {
      if (!(error instanceof WssMessageError)) throw error
      this.#quarantine()
      return
    }
    if (message.value.infoHash !== this.#infoHash) {
      this.#quarantine()
      return
    }

    if (message.kind === 'announce') {
      if (message.value.failureReason !== null) {
        const error = new WssTrackerError('TRACKER_FAILURE')
        const awaitingResponse = this.#pendingAnnounce !== null
        this.#rejectPendingAnnounce(error)
        if (!awaitingResponse) this.#notifyFailure(error)
        return
      }
      if (!this.#pendingAnnounce) return
      if (message.value.trackerId !== null) {
        this.#trackerId = message.value.trackerId
      }
      this.#onInterval(
        message.value.interval ?? WSS_TRACKER_LIMITS.defaultIntervalSeconds
      )
      this.#resolvePendingAnnounce()
      return
    }

    if (!this.#acceptSignal()) {
      this.#quarantine()
      return
    }

    let sdp: string
    try {
      sdp = filterIceCandidates(message.value.sdp, {
        allowPrivateNetwork: this.#allowPrivateNetwork
      })
    } catch {
      return
    }
    if (message.value.peerId === this.#peerId) return

    if (message.kind === 'signal' && message.value.kind === 'answer') {
      // An offer identifier is consumed before its one answer is processed, so
      // a late, duplicate, or replayed answer creates no peer.
      this.#expireOffers()
      if (!this.#pendingOffers.delete(message.value.offerId)) return
      this.#onAnswer({
        offerId: message.value.offerId,
        peerId: message.value.peerId,
        sdp
      })
      return
    }

    this.#onOffer({
      offerId: message.value.offerId,
      peerId: message.value.peerId,
      sdp
    })
  }

  #acceptSignal(): boolean {
    const now = this.#now()
    while (
      this.#signalTimestamps.length > 0 &&
      now - (this.#signalTimestamps[0] as number) >= 60_000
    ) {
      this.#signalTimestamps.shift()
    }
    if (
      this.#signalTimestamps.length >= WSS_TRACKER_LIMITS.maxSignalsPerMinute
    ) {
      return false
    }
    this.#signalTimestamps.push(now)
    return true
  }

  #expireOffers(): void {
    const now = this.#now()
    for (const [offerId, offer] of this.#pendingOffers) {
      if (offer.expiresAtMs <= now) this.#pendingOffers.delete(offerId)
    }
  }

  #quarantine(): void {
    this.#quarantined = true
    this.#pendingOffers.clear()
    const error = new WssTrackerError('QUARANTINED')
    const awaitingResponse = this.#pendingAnnounce !== null
    this.#rejectPendingAnnounce(error)
    if (!awaitingResponse) this.#notifyFailure(error)
    const socket = this.#socket
    this.#socket = null
    try {
      socket?.terminate()
    } catch {
      // The endpoint stays quarantined for the rest of the activation.
    }
  }

  #expectAnnounceResponse(): Promise<void> {
    if (this.#pendingAnnounce) {
      throw new WssTrackerError('TRACKER_FAILURE')
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new WssTrackerError('TRACKER_FAILURE')
        this.#rejectPendingAnnounce(error)
      }, WSS_TRACKER_LIMITS.announceDeadlineMs)
      timer.unref()
      this.#pendingAnnounce = { reject, resolve, timer }
    })
  }

  #resolvePendingAnnounce(): void {
    const pending = this.#pendingAnnounce
    if (!pending) return
    this.#pendingAnnounce = null
    clearTimeout(pending.timer)
    pending.resolve()
  }

  #rejectPendingAnnounce(error: WssTrackerError): void {
    const pending = this.#pendingAnnounce
    if (!pending) return
    this.#pendingAnnounce = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  #notifyFailure(error: WssTrackerError): void {
    if (this.#closed || this.#failureNotified) return
    this.#failureNotified = true
    try {
      this.#onFailure(error)
    } catch {
      // Lifecycle observation cannot change endpoint failure.
    }
  }

  #transportFailed(socket: WssSocket, error: WssTrackerError): void {
    if (this.#socket !== socket || this.#closed) return
    this.#socket = null
    const awaitingResponse = this.#pendingAnnounce !== null
    this.#rejectPendingAnnounce(error)
    if (this.#didConnect && !awaitingResponse) this.#notifyFailure(error)
  }
}
