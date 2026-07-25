import {
  WSS_TRACKER_LIMITS,
  WssTrackerEndpoint,
  type WssOfferDescription,
  type WssSocket
} from './wss-tracker'

export const WSS_ACTIVATION_LIMITS = Object.freeze({
  /** Successful tiers kept live for one torrent; the rest stay dormant. */
  maxLiveEndpoints: 4,
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
    input: Readonly<{ infoHash: string; url: string }>
  ) => Promise<WssSocket>
  createOffers: (count: number) => Promise<ReadonlyArray<WssOfferDescription>>
  infoHash: string
  onAnswer: (
    answer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  onOffer?: (
    offer: Readonly<{ offerId: string; peerId: string; sdp: string }>
  ) => void
  peerId: string
  progress: () => WssActivationProgress
  tiers: ReadonlyArray<ReadonlyArray<string>>
}>

export type WssActivationSnapshot = Readonly<{
  dormant: ReadonlyArray<string>
  live: ReadonlyArray<string>
}>

type LiveEndpoint = {
  /** Set once a `started` announce reached the endpoint. */
  contacted: boolean
  endpoint: WssTrackerEndpoint
  /** Activation-scoped bit: the one `stopped` attempt is never repeated. */
  stoppedAttempted: boolean
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
): ReadonlyArray<string> {
  const ordered: string[] = []
  const seen = new Set<string>()
  const depth = Math.max(0, ...tiers.map(tier => tier.length))

  for (let position = 0; position < depth; position += 1) {
    for (const tier of tiers) {
      const url = tier[position]
      if (url === undefined || seen.has(url)) continue
      if (!url.startsWith('wss://')) continue
      seen.add(url)
      ordered.push(url)
      if (ordered.length >= WSS_ACTIVATION_LIMITS.maxEndpoints) return ordered
    }
  }
  return ordered
}

/**
 * One torrent's WSS tracker activation.
 *
 * At most four endpoints stay live; the rest remain dormant failovers that are
 * promoted only when a live one fails. Nothing reconnects on its own: a closed
 * endpoint stays closed until the activation is started again.
 */
export class WssActivation {
  readonly #options: WssActivationOptions
  readonly #candidates: ReadonlyArray<string>
  readonly #live = new Map<string, LiveEndpoint>()
  readonly #closing = new Set<Promise<void>>()
  #nextCandidate = 0
  #started = false

  constructor(options: WssActivationOptions) {
    this.#options = options
    this.#candidates = scheduleOrder(options.tiers)
  }

  get endpointCount(): number {
    return this.#candidates.length
  }

  snapshot(): WssActivationSnapshot {
    const live = [...this.#live.keys()]
    return {
      dormant: this.#candidates.filter(url => !this.#live.has(url)),
      live
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
    while (
      this.#started &&
      this.#live.size < WSS_ACTIVATION_LIMITS.maxLiveEndpoints &&
      this.#nextCandidate < this.#candidates.length
    ) {
      const url = this.#candidates[this.#nextCandidate]
      this.#nextCandidate += 1
      if (url === undefined) break
      await this.#open(url)
    }
  }

  async #open(url: string): Promise<void> {
    let socket: WssSocket
    try {
      socket = await this.#options.connectSocket({
        infoHash: this.#options.infoHash,
        url
      })
    } catch {
      return
    }

    const endpoint = new WssTrackerEndpoint({
      allowPrivateNetwork: this.#options.allowPrivateNetwork,
      createOffers: this.#options.createOffers,
      createSocket: () => socket,
      infoHash: this.#options.infoHash,
      onAnswer: this.#options.onAnswer,
      onInterval: seconds => this.#schedule(url, seconds),
      ...(this.#options.onOffer ? { onOffer: this.#options.onOffer } : {}),
      peerId: this.#options.peerId,
      trackerUrl: url
    })

    const entry: LiveEndpoint = {
      contacted: false,
      endpoint,
      stoppedAttempted: false,
      timer: null,
      url
    }
    this.#live.set(url, entry)

    try {
      await endpoint.connect()
      await this.#announce(entry, 'started')
      entry.contacted = true
    } catch {
      await this.#retire(url)
      return
    }
    this.#schedule(url, WSS_TRACKER_LIMITS.defaultIntervalSeconds)
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
