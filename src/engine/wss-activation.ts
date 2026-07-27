import {
  WSS_TRACKER_LIMITS,
  WssTrackerEndpoint,
  type WssOfferDescription,
  type WssSocket
} from './wss-tracker'

export const WSS_ACTIVATION_LIMITS = Object.freeze({
  /** Successful tiers kept live for one torrent; the rest stay dormant. */
  maxLiveEndpoints: 4,
  /** An active tier holds one socket; its other URLs are its failovers. */
  maxLivePerTier: 1,
  /** Endpoints considered for one torrent, live and dormant together. */
  maxEndpoints: 16,
  maxOffersPerAnnounce: WSS_TRACKER_LIMITS.maxOffersPerAnnounce
} as const)

type WssActivationProgress = Readonly<{
  downloaded: number
  left: number
  uploaded: number
}>

export type WssActivationOptions = Readonly<{
  allowPrivateNetwork: boolean
  /** Opens one pinned, policy-approved socket, or rejects. */
  connectSocket: (
    input: Readonly<{ infoHash: string; signal?: AbortSignal; url: string }>
  ) => Promise<WssSocket>
  /** The tracker URL identifies the endpoint whose budget the offers use. */
  createOffers: (
    count: number,
    trackerUrl: string
  ) => Promise<ReadonlyArray<WssOfferDescription>>
  infoHash: string
  onActivated?: (trackerUrl: string) => void
  onAnswer: (
    answer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  /**
   * Handles one remote offer. `respond` returns this client's answer through
   * the same endpoint, and does nothing once that endpoint is gone.
   */
  onOffer?: (
    offer: Readonly<{ offerId: string; peerId: string; sdp: string }>,
    trackerUrl: string,
    respond: (answer: Readonly<{ offerId: string; sdp: string }>) => void
  ) => void
  /** Unknown-private staging awaits full retirement before failover. */
  onRetireEndpoint?: (trackerUrl: string) => Promise<void> | void
  onExhausted?: () => void
  peerId: string
  progress: () => WssActivationProgress
  serialRetirement?: boolean
  /**
   * A known-private torrent announces to one endpoint at a time. Its tiers
   * collapse into a single serial chain rather than up to four live sockets,
   * so its identity reaches only the endpoint currently selected.
   */
  private?: boolean
  tiers: ReadonlyArray<ReadonlyArray<string>>
}>

type WssRemoteOffer = Readonly<{
  offerId: string
  peerId: string
  sdp: string
}>

export type WssActivationSnapshot = Readonly<{
  dormant: ReadonlyArray<string>
  live: ReadonlyArray<string>
}>

type Candidate = Readonly<{ tier: number; url: string }>

type LiveEndpoint = {
  /** Set once a `started` announce reached the endpoint. */
  contacted: boolean
  endpoint: WssTrackerEndpoint
  /** Activation-scoped bit: the one `stopped` attempt is never repeated. */
  stoppedAttempted: boolean
  tier: number
  timer: ReturnType<typeof setTimeout> | null
  url: string
}

/**
 * Orders the endpoints the way the scheduler should try them: every tier's
 * first endpoint before any tier's second, so one failing tier cannot starve
 * the others.
 */
function scheduleOrder(
  tiers: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<Candidate> {
  const ordered: Candidate[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...tiers.map(tier => tier.length))

  for (let position = 0; position < depth; position += 1) {
    for (const [tier, urls] of tiers.entries()) {
      const url = urls[position]
      if (url === undefined || seen.has(url)) continue
      if (!url.startsWith('wss://')) continue
      seen.add(url)
      ordered.push({ tier, url })
      if (ordered.length >= WSS_ACTIVATION_LIMITS.maxEndpoints) return ordered
    }
  }
  return ordered
}

/**
 * One torrent's WSS tracker activation.
 *
 * At most four endpoints stay live and an active tier holds only one of them;
 * the rest remain dormant failovers that are promoted only when a live one
 * fails. Nothing reconnects on its own: a closed endpoint stays closed until
 * the activation is started again, and no URL is opened twice.
 */
export class WssActivation {
  readonly #options: WssActivationOptions
  readonly #candidates: ReadonlyArray<Candidate>
  readonly #live = new Map<string, LiveEndpoint>()
  readonly #closing = new Set<Promise<void>>()
  /** Every URL the activation has already opened once. Nothing is retried. */
  readonly #attempted = new Set<string>()
  readonly #openController = new AbortController()
  #started = false
  #exhaustedSent = false

  constructor(options: WssActivationOptions) {
    this.#options = options
    this.#candidates = scheduleOrder(options.tiers)
  }

  get endpointCount(): number {
    return this.#candidates.length
  }

  snapshot(): WssActivationSnapshot {
    return {
      dormant: this.#candidates
        .filter(candidate => !this.#live.has(candidate.url))
        .map(candidate => candidate.url),
      live: [...this.#live.keys()]
    }
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#fill()
  }

  /**
   * Sends the one bounded `stopped` per endpoint and closes every socket. The
   * endpoints tear down together so the whole activation costs one grace
   * period rather than one per endpoint.
   */
  async stop(): Promise<void> {
    this.#started = false
    this.#openController.abort()
    const entries = [...this.#live.values()]
    this.#live.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    await Promise.all(entries.map(entry => this.#attemptStopped(entry)))
    await Promise.all([
      ...entries.map(entry => this.#close(entry)),
      ...this.#closing
    ])
  }

  /** Opens dormant endpoints until the live budget is met or none remain. */
  async #fill(): Promise<void> {
    for (;;) {
      const candidate = this.#nextCandidate()
      if (!candidate) {
        if (this.#started && this.#live.size === 0 && !this.#exhaustedSent) {
          this.#exhaustedSent = true
          try {
            this.#options.onExhausted?.()
          } catch {
            // Lifecycle observation cannot change tracker scheduling.
          }
        }
        return
      }
      this.#attempted.add(candidate.url)
      await this.#open(candidate)
    }
  }

  /**
   * The next untried endpoint whose tier holds no live socket. A tier's other
   * URLs are its failovers, so an active tier is never opened twice.
   */
  #nextCandidate(): Candidate | null {
    const liveLimit = this.#options.private
      ? 1
      : WSS_ACTIVATION_LIMITS.maxLiveEndpoints
    if (!this.#started || this.#live.size >= liveLimit) {
      return null
    }
    const perTier = new Map<number, number>()
    for (const entry of this.#live.values()) {
      perTier.set(entry.tier, (perTier.get(entry.tier) ?? 0) + 1)
    }
    return (
      this.#candidates.find(
        candidate =>
          !this.#attempted.has(candidate.url) &&
          (perTier.get(candidate.tier) ?? 0) <
            WSS_ACTIVATION_LIMITS.maxLivePerTier
      ) ?? null
    )
  }

  async #open({ tier, url }: Candidate): Promise<void> {
    let socket: WssSocket
    try {
      socket = await this.#options.connectSocket({
        infoHash: this.#options.infoHash,
        signal: this.#openController.signal,
        url
      })
    } catch {
      return
    }
    if (!this.#started) {
      try {
        socket.terminate()
      } catch {
        // The socket is already closing.
      }
      return
    }

    const onOffer = this.#options.onOffer
    const endpoint = new WssTrackerEndpoint({
      allowPrivateNetwork: this.#options.allowPrivateNetwork,
      createOffers: count => this.#options.createOffers(count, url),
      createSocket: () => socket,
      infoHash: this.#options.infoHash,
      onAnswer: this.#options.onAnswer,
      onFailure: () => {
        void this.#retire(url)
      },
      onInterval: seconds => this.#schedule(url, seconds),
      ...(onOffer
        ? {
            onOffer: (offer: WssRemoteOffer) => {
              onOffer(offer, url, answer => {
                this.#respond(url, answer, offer.peerId)
              })
            }
          }
        : {}),
      peerId: this.#options.peerId,
      trackerUrl: url
    })

    const entry: LiveEndpoint = {
      contacted: false,
      endpoint,
      stoppedAttempted: false,
      tier,
      timer: null,
      url
    }
    this.#live.set(url, entry)

    try {
      await endpoint.connect()
      await this.#announce(entry, 'started')
      entry.contacted = true
      try {
        this.#options.onActivated?.(url)
      } catch {
        // Lifecycle observation cannot change tracker scheduling.
      }
    } catch {
      await this.#retire(url)
      return
    }
  }

  /**
   * Sends one answer back through the endpoint that carried its offer. A
   * retired or closed endpoint silently drops it: no other socket may answer
   * on its behalf.
   */
  #respond(
    url: string,
    answer: Readonly<{ offerId: string; sdp: string }>,
    toPeerId: string
  ): void {
    const entry = this.#live.get(url)
    if (!entry) return
    try {
      entry.endpoint.answer({ ...answer, toPeerId })
    } catch {
      void this.#retire(url)
    }
  }

  #schedule(url: string, seconds: number): void {
    const entry = this.#live.get(url)
    if (!entry || !this.#started) return
    if (entry.timer) clearTimeout(entry.timer)

    const delay = Math.max(1, Math.min(seconds, 86_400)) * 1_000
    entry.timer = setTimeout(() => {
      void this.#announce(entry).catch(() => undefined)
    }, delay)
    entry.timer.unref?.()
  }

  async #announce(
    entry: LiveEndpoint,
    event?: 'completed' | 'started'
  ): Promise<void> {
    const progress = this.#options.progress()
    try {
      await entry.endpoint.announce({
        downloaded: progress.downloaded,
        ...(event ? { event } : {}),
        left: progress.left,
        numwant: WSS_ACTIVATION_LIMITS.maxOffersPerAnnounce,
        uploaded: progress.uploaded
      })
    } catch (error) {
      await this.#retire(entry.url)
      throw error
    }
  }

  /**
   * One non-retrying best-effort attempt per endpoint. The attempted bit is set
   * before the frame so later teardown never repeats it, and a transport that
   * is no longer usable is skipped rather than revived.
   */
  async #attemptStopped(entry: LiveEndpoint): Promise<void> {
    if (!entry.contacted || entry.stoppedAttempted) return
    entry.stoppedAttempted = true
    if (!entry.endpoint.connected) return

    const progress = this.#options.progress()
    try {
      await entry.endpoint.announce({
        downloaded: progress.downloaded,
        event: 'stopped',
        left: progress.left,
        numwant: 0,
        uploaded: progress.uploaded
      })
    } catch {
      // The stopped announce is best effort and never retried.
    }
  }

  /** A failed endpoint is dropped and its slot given to the next dormant one. */
  async #retire(url: string): Promise<void> {
    const entry = this.#live.get(url)
    if (!entry) return
    this.#live.delete(url)
    if (entry.timer) clearTimeout(entry.timer)
    await this.#attemptStopped(entry)
    if (this.#options.serialRetirement) {
      await this.#close(entry)
      await this.#options.onRetireEndpoint?.(entry.url)
      await this.#fill()
      return
    }
    // The close runs its grace period alongside the replacement rather than
    // ahead of it: a retired endpoint never blocks its failover.
    const closing = this.#close(entry).finally(() => {
      this.#closing.delete(closing)
    })
    this.#closing.add(closing)
    await this.#fill()
  }

  async #close(entry: LiveEndpoint): Promise<void> {
    try {
      await entry.endpoint.close()
    } catch {
      // Teardown continues through a failing endpoint.
    }
  }
}
