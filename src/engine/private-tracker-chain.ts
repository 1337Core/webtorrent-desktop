export const PRIVATE_CHAIN_LIMITS = Object.freeze({
  maxBackoffSeconds: 1_800,
  maxEndpoints: 32,
  minBackoffSeconds: 60
})

/**
 * One endpoint's live announce, whichever transport serves it.
 *
 * A member owns exactly one URL. It reports failure through the `onFailed`
 * hook it was built with, and the chain — never the member — decides what
 * happens next.
 */
export type PrivateChainMember = Readonly<{
  notifyCompleted?: () => void
  start: () => Promise<void> | void
  stop: () => Promise<void>
}>

export type PrivateChainMemberFactory = (
  input: Readonly<{ onFailed: () => void; url: string }>
) => PrivateChainMember

export type PrivateTrackerChainOptions = Readonly<{
  /**
   * Every announce URL of one private torrent, in the order the metadata
   * declared them, across all transports.
   */
  endpoints: ReadonlyArray<string>
  /** Builds the member that serves one URL. */
  createMember: PrivateChainMemberFactory
  now?: () => number
  /** Deterministic backoff for tests; production uses the jittered default. */
  backoffMs?: (round: number) => number
  random?: () => number
}>

/**
 * The single announce chain of a known-private torrent.
 *
 * A private torrent must not tell more than one tracker who and where it is.
 * Its HTTP and WSS endpoints are therefore not two independently serialized
 * lists but one ordered sequence with exactly one member alive at a time: the
 * active member is fully stopped, and its peers and sockets retired with it,
 * before the next endpoint is ever constructed.
 *
 * A failing endpoint advances the chain. Exhausting the whole sequence starts
 * it again after a bounded, jittered delay, so a torrent whose only tracker is
 * temporarily down keeps retrying that tracker without ever widening its
 * exposure.
 */
export class PrivateTrackerChain {
  readonly #endpoints: ReadonlyArray<string>
  readonly #createMember: PrivateChainMemberFactory
  readonly #now: () => number
  readonly #backoffMs: (round: number) => number
  #active: PrivateChainMember | null = null
  #activeUrl: string | null = null
  #advancing: Promise<void> | null = null
  #closed = false
  #index = 0
  #round = 0
  #started = false
  #timer: NodeJS.Timeout | null = null

  constructor(options: PrivateTrackerChainOptions) {
    const random = options.random ?? Math.random.bind(Math)
    this.#endpoints = options.endpoints.slice(
      0,
      PRIVATE_CHAIN_LIMITS.maxEndpoints
    )
    this.#createMember = options.createMember
    this.#now = options.now ?? Date.now
    this.#backoffMs =
      options.backoffMs ??
      (round => {
        const exponential = Math.min(
          PRIVATE_CHAIN_LIMITS.minBackoffSeconds * 2 ** Math.max(round - 1, 0),
          PRIVATE_CHAIN_LIMITS.maxBackoffSeconds
        )
        // Half to full of the exponential step, so retries of one tracker do
        // not line up across restarts.
        const seconds = Math.round(exponential * (0.5 + random() * 0.5))
        return (
          Math.min(
            Math.max(seconds, PRIVATE_CHAIN_LIMITS.minBackoffSeconds),
            PRIVATE_CHAIN_LIMITS.maxBackoffSeconds
          ) * 1_000
        )
      })
  }

  /** The endpoint currently in contact, or null when none is. */
  get activeUrl(): string | null {
    return this.#activeUrl
  }

  get endpointCount(): number {
    return this.#endpoints.length
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed || this.#endpoints.length === 0) return
    this.#started = true
    await this.#activate()
  }

  notifyCompleted(): void {
    this.#active?.notifyCompleted?.()
  }

  async stop(): Promise<void> {
    this.#closed = true
    this.#started = false
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    await this.#advancing
    await this.#retire()
  }

  /** Stops and forgets the live member, so nothing of it outlives the switch. */
  async #retire(): Promise<void> {
    const member = this.#active
    this.#active = null
    this.#activeUrl = null
    if (!member) return
    try {
      await member.stop()
    } catch {
      // A member that cannot be stopped cleanly must not strand the chain.
    }
  }

  async #activate(): Promise<void> {
    if (this.#closed || !this.#started) return
    const url = this.#endpoints[this.#index]
    if (url === undefined) return

    let advanced = false
    const member = this.#createMember({
      onFailed: () => {
        // One failure advances the chain once, however many times the member
        // reports it.
        if (advanced) return
        advanced = true
        this.#advance()
      },
      url
    })
    this.#active = member
    this.#activeUrl = url
    try {
      await member.start()
    } catch {
      if (!advanced) {
        advanced = true
        this.#advance()
      }
    }
  }

  #advance(): void {
    if (this.#closed) return
    this.#advancing = (async () => {
      // The retiring endpoint releases its peers and sockets before the next
      // endpoint exists; this is what keeps exposure to one tracker.
      await this.#retire()
      if (this.#closed || !this.#started) return

      this.#index += 1
      if (this.#index < this.#endpoints.length) {
        await this.#activate()
        return
      }

      this.#index = 0
      this.#round += 1
      const delayMs = this.#backoffMs(this.#round)
      const resumeAtMs = this.#now() + delayMs
      this.#timer = setTimeout(
        () => {
          this.#timer = null
          if (this.#closed || !this.#started) return
          if (this.#now() < resumeAtMs) return
          void this.#activate()
        },
        Math.max(delayMs, 0)
      )
      this.#timer.unref?.()
    })()
    void this.#advancing.catch(() => undefined)
  }
}
