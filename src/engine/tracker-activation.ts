import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  TrackerHttpError,
  type TrackerAnnounceInput,
  type TrackerAnnounceResponse
} from './tracker-http'

export const TRACKER_ACTIVATION_LIMITS = Object.freeze({
  localDeferralMs: 5_000,
  maxBackoffSeconds: 1_800,
  maxTiers: 8,
  maxUniqueUrls: 32,
  maxUrlsPerTier: 4,
  minBackoffSeconds: 60,
  stopGraceMs: 1_000
})

export type TrackerActivationErrorCode = 'INPUT_INVALID' | 'LIMIT_EXCEEDED'

export class TrackerActivationError extends Error {
  readonly code: TrackerActivationErrorCode

  constructor(code: TrackerActivationErrorCode) {
    super(`Tracker activation was rejected: ${code}.`)
    this.name = 'TrackerActivationError'
    this.code = code
  }
}

export type TrackerAnnounceTransport = Readonly<{
  announce(input: TrackerAnnounceInput): Promise<TrackerAnnounceResponse>
}>

export type TrackerActivationProgress = Readonly<{
  downloaded: number
  left: number
  uploaded: number
}>

export type TrackerActivationPeers = Readonly<{
  endpoint: string
  peers: TrackerAnnounceResponse['peers']
}>

export type TrackerActivationOptions = Readonly<{
  allowHttp: boolean
  allowPrivateNetwork: boolean
  infoHash: string
  now?: () => number
  onActivated?: (endpoint: string) => void
  onExhausted?: () => void
  onPeers: (delivery: TrackerActivationPeers) => void
  /**
   * Private failover must destroy every peer, queued candidate, and lease of
   * the retiring tracker generation before a replacement endpoint activates.
   */
  onRetireGeneration?: () => Promise<void> | void
  peerId: Uint8Array
  port: number
  private: boolean
  progress: () => TrackerActivationProgress
  random?: () => number
  sessionSeed: string
  /** Staging tries this activation's endpoints once, without backoff. */
  singlePass?: boolean
  tiers: ReadonlyArray<ReadonlyArray<string>>
  transport: TrackerAnnounceTransport
}>

type TrackerActivationEndpointSnapshot = Readonly<{
  active: boolean
  contacted: boolean
  stoppedAttempted: boolean
  url: string
}>

export type TrackerActivationUnitSnapshot = Readonly<{
  endpoints: ReadonlyArray<TrackerActivationEndpointSnapshot>
  failureRound: number
  key: string
  succeeded: boolean
}>

type EndpointState = {
  contacted: boolean
  stopController: AbortController | null
  stoppedAttempted: boolean
  trackerId: Uint8Array | null
  url: string
}

type UnitState = {
  activeIndex: number
  closed: boolean
  endpoints: EndpointState[]
  failureRound: number
  floorUntilMs: number
  inFlight: AbortController | null
  key: string
  pendingCompleted: boolean
  running: boolean
  succeeded: boolean
  timer: NodeJS.Timeout | null
}

const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/u

function infoHashBytes(infoHash: string): Uint8Array {
  if (!INFO_HASH_PATTERN.test(infoHash)) {
    throw new TrackerActivationError('INPUT_INVALID')
  }
  const bytes = new Uint8Array(20)
  for (let index = 0; index < 20; index += 1) {
    bytes[index] = Number.parseInt(infoHash.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Deduplicates by first occurrence across every tier, preserves tier order,
 * and shuffles inside each tier exactly once per activation.
 */
function normalizeTiers(
  tiers: ReadonlyArray<ReadonlyArray<string>>,
  random: () => number
): string[][] {
  if (!Array.isArray(tiers)) throw new TrackerActivationError('INPUT_INVALID')
  if (tiers.length > TRACKER_ACTIVATION_LIMITS.maxTiers) {
    throw new TrackerActivationError('LIMIT_EXCEEDED')
  }

  const seen = new Set<string>()
  const result: string[][] = []
  for (const tier of tiers) {
    if (!Array.isArray(tier)) throw new TrackerActivationError('INPUT_INVALID')
    if (tier.length > TRACKER_ACTIVATION_LIMITS.maxUrlsPerTier) {
      throw new TrackerActivationError('LIMIT_EXCEEDED')
    }
    const unique: string[] = []
    for (const url of tier) {
      if (typeof url !== 'string' || url === '') {
        throw new TrackerActivationError('INPUT_INVALID')
      }
      if (seen.has(url)) continue
      seen.add(url)
      if (seen.size > TRACKER_ACTIVATION_LIMITS.maxUniqueUrls) {
        throw new TrackerActivationError('LIMIT_EXCEEDED')
      }
      unique.push(url)
    }
    if (unique.length > 0) result.push(shuffle(unique, random))
  }
  return result
}

function shuffle(values: string[], random: () => number): string[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const source = random()
    if (!Number.isFinite(source) || source < 0 || source >= 1) {
      throw new TrackerActivationError('INPUT_INVALID')
    }
    const target = Math.floor(source * (index + 1))
    const held = values[index] as string
    values[index] = values[target] as string
    values[target] = held
  }
  return values
}

/**
 * A deterministic factor in [0.9, 1.1] derived from the engine session seed,
 * info hash, scheduling unit, and failure round. Retries stay spread out
 * without depending on wall-clock randomness during a test or a replay.
 */
function backoffJitter(
  sessionSeed: string,
  infoHash: string,
  unitKey: string,
  round: number
): number {
  const digest = createHash('sha256')
    .update(`${sessionSeed}|${infoHash}|${unitKey}|${round}`)
    .digest()
  const sample = digest.readUInt32BE(0) / 0xff_ff_ff_ff
  return 0.9 + sample * 0.2
}

function endpointSnapshot(
  unit: UnitState,
  endpoint: EndpointState,
  index: number
): TrackerActivationEndpointSnapshot {
  return {
    active: index === unit.activeIndex,
    contacted: endpoint.contacted,
    stoppedAttempted: endpoint.stoppedAttempted,
    url: endpoint.url
  }
}

/**
 * Owns one torrent's tracker announce lifecycle above the mediated transport.
 * Public torrents run every tier concurrently with one in-flight endpoint per
 * tier; private torrents keep exactly one endpoint active across all tiers.
 */
export class TrackerActivation {
  readonly #allowHttp: boolean
  readonly #allowPrivateNetwork: boolean
  readonly #infoHash: string
  readonly #infoHashBytes: Uint8Array
  readonly #now: () => number
  readonly #onActivated: (endpoint: string) => void
  readonly #onExhausted: () => void
  readonly #onPeers: (delivery: TrackerActivationPeers) => void
  readonly #onRetireGeneration: () => Promise<void> | void
  readonly #peerId: Uint8Array
  readonly #pendingStops = new Set<Promise<void>>()
  readonly #port: number
  readonly #private: boolean
  readonly #progress: () => TrackerActivationProgress
  readonly #sessionSeed: string
  readonly #singlePass: boolean
  readonly #stopController = new AbortController()
  readonly #transport: TrackerAnnounceTransport
  readonly #units: UnitState[]
  #closed = false
  #completedSent = false
  #seeding = false
  #started = false
  #stopPromise: Promise<void> | null = null

  constructor(options: TrackerActivationOptions) {
    if (
      typeof options.allowHttp !== 'boolean' ||
      typeof options.allowPrivateNetwork !== 'boolean' ||
      typeof options.private !== 'boolean' ||
      typeof options.sessionSeed !== 'string' ||
      options.sessionSeed === '' ||
      !(options.peerId instanceof Uint8Array) ||
      options.peerId.byteLength !== 20 ||
      !Number.isSafeInteger(options.port) ||
      options.port < 1 ||
      options.port > 65_535
    ) {
      throw new TrackerActivationError('INPUT_INVALID')
    }

    this.#allowHttp = options.allowHttp
    this.#allowPrivateNetwork = options.allowPrivateNetwork
    this.#infoHash = options.infoHash
    this.#infoHashBytes = infoHashBytes(options.infoHash)
    this.#now = options.now ?? (() => performance.now())
    this.#onActivated = options.onActivated ?? (() => undefined)
    this.#onExhausted = options.onExhausted ?? (() => undefined)
    this.#onPeers = options.onPeers
    this.#onRetireGeneration = options.onRetireGeneration ?? (() => undefined)
    this.#peerId = options.peerId.slice()
    this.#port = options.port
    this.#private = options.private
    this.#progress = options.progress
    this.#sessionSeed = options.sessionSeed
    this.#singlePass = options.singlePass ?? false
    this.#transport = options.transport

    const tiers = normalizeTiers(
      options.tiers,
      options.random ?? Math.random.bind(Math)
    )
    this.#units = this.#private
      ? [createUnit('private', tiers.flat())]
      : tiers.map((tier, index) => createUnit(`tier:${index}`, tier))
  }

  get endpointCount(): number {
    return this.#units.reduce((total, unit) => total + unit.endpoints.length, 0)
  }

  describe(): ReadonlyArray<TrackerActivationUnitSnapshot> {
    return this.#units.map(unit => ({
      endpoints: unit.endpoints.map((endpoint, index) =>
        endpointSnapshot(unit, endpoint, index)
      ),
      failureRound: unit.failureRound,
      key: unit.key,
      succeeded: unit.succeeded
    }))
  }

  start(): void {
    if (this.#started || this.#closed) return
    this.#started = true
    this.#seeding = this.#progress().left === 0
    for (const unit of this.#units) this.#schedule(unit, 0)
  }

  /**
   * The engine reports the first positive-to-zero transition. An activation
   * that began complete never claims a download it did not perform.
   */
  notifyCompleted(): void {
    if (this.#closed || this.#seeding || this.#completedSent) return
    this.#completedSent = true
    for (const unit of this.#units) {
      if (!unit.succeeded || unit.closed) continue
      unit.pendingCompleted = true
      this.#schedule(unit, 0)
    }
  }

  reannounce(): void {
    if (this.#closed || !this.#started) return
    for (const unit of this.#units) {
      if (unit.closed || unit.running) continue
      this.#schedule(unit, Math.max(0, unit.floorUntilMs - this.#now()))
    }
  }

  /** Synchronously prevents any new announce, retry, or peer delivery. */
  freeze(): void {
    if (this.#closed) return
    this.#closed = true
    for (const unit of this.#units) {
      unit.closed = true
      this.#clearTimer(unit)
      unit.inFlight?.abort()
      unit.inFlight = null
    }
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce()
    return this.#stopPromise
  }

  async #stopOnce(): Promise<void> {
    this.freeze()

    for (const unit of this.#units) {
      for (const endpoint of unit.endpoints) this.#attemptStopped(endpoint)
    }

    const outstanding = [...this.#pendingStops]
    if (outstanding.length === 0) return

    let graceTimer: NodeJS.Timeout | null = null
    const grace = new Promise<void>(resolve => {
      graceTimer = setTimeout(resolve, TRACKER_ACTIVATION_LIMITS.stopGraceMs)
      graceTimer.unref()
    })
    await Promise.race([Promise.allSettled(outstanding), grace])
    if (graceTimer) clearTimeout(graceTimer)
    this.#stopController.abort()
  }

  #schedule(unit: UnitState, delayMs: number): void {
    if (unit.closed || this.#closed) return
    this.#clearTimer(unit)
    const timer = setTimeout(
      () => {
        unit.timer = null
        void this.#run(unit)
      },
      Math.max(0, Math.round(delayMs))
    )
    timer.unref()
    unit.timer = timer
  }

  #clearTimer(unit: UnitState): void {
    if (!unit.timer) return
    clearTimeout(unit.timer)
    unit.timer = null
  }

  async #run(unit: UnitState): Promise<void> {
    if (unit.closed || this.#closed || unit.running) return
    const endpoint = unit.endpoints[unit.activeIndex]
    if (!endpoint) return

    const event = !endpoint.contacted
      ? 'started'
      : unit.pendingCompleted
        ? 'completed'
        : undefined
    const controller = new AbortController()
    unit.inFlight = controller
    unit.running = true
    endpoint.contacted = true

    try {
      const progress = this.#progress()
      const response = await this.#transport.announce({
        allowHttp: this.#allowHttp,
        allowPrivateNetwork: this.#allowPrivateNetwork,
        downloaded: progress.downloaded,
        event,
        infoHash: this.#infoHashBytes,
        left: progress.left,
        peerId: this.#peerId,
        port: this.#port,
        signal: controller.signal,
        ...(endpoint.trackerId ? { trackerId: endpoint.trackerId } : {}),
        trackerUrl: endpoint.url,
        uploaded: progress.uploaded
      })
      if (unit.closed || this.#closed) return
      this.#acceptSuccess(unit, endpoint, response, event)
    } catch (error) {
      if (unit.closed || this.#closed) return
      if (error instanceof TrackerHttpError && error.code === 'ABORTED') return
      if (isLocalDeferral(error)) {
        this.#schedule(unit, TRACKER_ACTIVATION_LIMITS.localDeferralMs)
        return
      }
      await this.#rotate(unit)
    } finally {
      unit.running = false
      if (unit.inFlight === controller) unit.inFlight = null
    }
  }

  #acceptSuccess(
    unit: UnitState,
    endpoint: EndpointState,
    response: TrackerAnnounceResponse,
    event: 'completed' | 'started' | undefined
  ): void {
    if (event === 'completed') unit.pendingCompleted = false
    if (response.trackerId) endpoint.trackerId = response.trackerId.slice()
    unit.failureRound = 0
    unit.succeeded = true
    this.#makeSticky(unit, endpoint)
    try {
      this.#onActivated(endpoint.url)
    } catch {
      // Lifecycle observation cannot change tracker scheduling.
    }

    if (response.peers.length > 0) {
      try {
        this.#onPeers({ endpoint: endpoint.url, peers: response.peers })
      } catch {
        // A delivery callback cannot fail the announce schedule.
      }
    }

    const intervalSeconds = Math.max(
      response.interval,
      response.minInterval ?? 0
    )
    const delayMs = intervalSeconds * 1_000
    unit.floorUntilMs = this.#now() + delayMs
    this.#schedule(unit, delayMs)
  }

  #makeSticky(unit: UnitState, endpoint: EndpointState): void {
    const index = unit.endpoints.indexOf(endpoint)
    if (index > 0) {
      unit.endpoints.splice(index, 1)
      unit.endpoints.unshift(endpoint)
    }
    unit.activeIndex = 0
  }

  async #rotate(unit: UnitState): Promise<void> {
    this.#clearTimer(unit)
    const retiring = unit.endpoints[unit.activeIndex]
    if (retiring) {
      const stopped = this.#attemptStopped(retiring)
      if (stopped) {
        let graceTimer: NodeJS.Timeout | null = null
        const grace = new Promise<void>(resolve => {
          graceTimer = setTimeout(
            resolve,
            TRACKER_ACTIVATION_LIMITS.stopGraceMs
          )
          graceTimer.unref()
        })
        await Promise.race([stopped, grace])
        if (graceTimer) clearTimeout(graceTimer)
        retiring.stopController?.abort()
      }
    }

    if (this.#private) {
      try {
        await this.#onRetireGeneration()
      } catch {
        // Retirement reporting cannot block the replacement endpoint.
      }
    }
    if (unit.closed || this.#closed) return

    unit.activeIndex += 1
    if (unit.activeIndex < unit.endpoints.length) {
      this.#schedule(unit, 0)
      return
    }

    unit.activeIndex = 0
    unit.failureRound += 1
    if (this.#singlePass) {
      unit.closed = true
      try {
        this.#onExhausted()
      } catch {
        // Lifecycle observation cannot change tracker scheduling.
      }
      return
    }
    this.#schedule(unit, this.#backoffMs(unit))
  }

  #backoffMs(unit: UnitState): number {
    const exponential = Math.min(
      TRACKER_ACTIVATION_LIMITS.minBackoffSeconds *
        2 ** (unit.failureRound - 1),
      TRACKER_ACTIVATION_LIMITS.maxBackoffSeconds
    )
    const jittered = Math.round(
      exponential *
        backoffJitter(
          this.#sessionSeed,
          this.#infoHash,
          unit.key,
          unit.failureRound
        )
    )
    const seconds = Math.min(
      Math.max(jittered, TRACKER_ACTIVATION_LIMITS.minBackoffSeconds),
      TRACKER_ACTIVATION_LIMITS.maxBackoffSeconds
    )
    return seconds * 1_000
  }

  /**
   * One non-retrying best-effort attempt per endpoint. The attempted bit is set
   * before the request so later teardown never repeats it.
   */
  #attemptStopped(endpoint: EndpointState): Promise<void> | null {
    if (!endpoint.contacted || endpoint.stoppedAttempted) return null
    endpoint.stoppedAttempted = true
    if (this.#stopController.signal.aborted) return null

    const controller = new AbortController()
    endpoint.stopController = controller
    const progress = this.#progress()
    const attempt = this.#transport
      .announce({
        allowHttp: this.#allowHttp,
        allowPrivateNetwork: this.#allowPrivateNetwork,
        downloaded: progress.downloaded,
        event: 'stopped',
        infoHash: this.#infoHashBytes,
        left: progress.left,
        peerId: this.#peerId,
        port: this.#port,
        signal: AbortSignal.any([
          this.#stopController.signal,
          controller.signal
        ]),
        ...(endpoint.trackerId ? { trackerId: endpoint.trackerId } : {}),
        trackerUrl: endpoint.url,
        uploaded: progress.uploaded
      })
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (endpoint.stopController === controller) {
          endpoint.stopController = null
        }
        this.#pendingStops.delete(attempt)
      })
    this.#pendingStops.add(attempt)
    return attempt
  }
}

function createUnit(key: string, urls: readonly string[]): UnitState {
  return {
    activeIndex: 0,
    closed: false,
    endpoints: urls.map(url => ({
      contacted: false,
      stopController: null,
      stoppedAttempted: false,
      trackerId: null,
      url
    })),
    failureRound: 0,
    floorUntilMs: 0,
    inFlight: null,
    key,
    pendingCompleted: false,
    running: false,
    succeeded: false,
    timer: null
  }
}

/**
 * Local capacity rejection is not a tracker failure: it must not rotate the
 * endpoint or advance the failure round.
 */
function isLocalDeferral(error: unknown): boolean {
  return error instanceof TrackerHttpError && error.code === 'CONCURRENCY_LIMIT'
}
