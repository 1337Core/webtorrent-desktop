export type StagingTrackerAttempt = Readonly<{
  /** Resolves after this endpoint has completed its started announce. */
  activated: Promise<void>
  /** Resolves only after this endpoint has failed its active cycle. */
  failed: Promise<void>
  /** Synchronously closes admission and cancels new work. */
  freeze: () => void
  start: () => void
  /** Completes stopped, peer, and transport retirement. */
  stop: () => Promise<void>
}>

export type StagingTrackerChainOptions = Readonly<{
  createAttempt: (endpoint: string) => StagingTrackerAttempt
  endpoints: ReadonlyArray<string>
}>

/**
 * The unknown-private tracker scheduler used only by metadata staging.
 *
 * Every repeated `tr=` value is one order-preserving chain, regardless of
 * protocol. A replacement attempt is not even constructed until the retiring
 * endpoint's stopped, peer, signaling, and transport cleanup has completed.
 */
export class StagingTrackerChain {
  readonly #options: StagingTrackerChainOptions
  readonly #closed: Promise<void>
  readonly #closeNow: () => void
  readonly ready: Promise<void>
  readonly #readyReject: (error: Error) => void
  readonly #readyResolve: () => void
  #attempt: StagingTrackerAttempt | null = null
  #closedSettled = false
  #readySettled = false
  #run: Promise<void> | null = null

  constructor(options: StagingTrackerChainOptions) {
    this.#options = options
    let closeNow = (): void => undefined
    this.#closed = new Promise(resolve => {
      closeNow = resolve
    })
    this.#closeNow = closeNow

    let readyResolve = (): void => undefined
    let readyReject = (_error: Error): void => undefined
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    this.#readyResolve = readyResolve
    this.#readyReject = readyReject
  }

  start(): void {
    this.#run ??= this.#runOnce()
  }

  freeze(): void {
    if (this.#closedSettled) return
    this.#closedSettled = true
    this.#attempt?.freeze()
    this.#closeNow()
    // A caller that freezes before activation treats startup as complete; the
    // acquisition already has its own success/error result at that point.
    this.#resolveReady()
  }

  async stop(): Promise<void> {
    this.freeze()
    await this.#run
  }

  async #runOnce(): Promise<void> {
    try {
      for (const endpoint of this.#options.endpoints) {
        if (this.#closedSettled) return
        const attempt = this.#options.createAttempt(endpoint)
        this.#attempt = attempt
        attempt.start()

        let outcome = await Promise.race([
          attempt.activated.then(() => 'active' as const),
          attempt.failed.then(() => 'failed' as const),
          this.#closed.then(() => 'closed' as const)
        ])
        if (outcome === 'closed') return

        if (outcome === 'active') {
          this.#resolveReady()
          outcome = await Promise.race([
            attempt.failed.then(() => 'failed' as const),
            this.#closed.then(() => 'closed' as const)
          ])
          if (outcome === 'closed') return
        }

        attempt.freeze()
        await attempt.stop()
        if (this.#closedSettled) return
      }
      if (!this.#readySettled) {
        this.#readySettled = true
        this.#readyReject(new Error('STAGING_TRACKERS_EXHAUSTED'))
      }
    } finally {
      const attempt = this.#attempt
      this.#attempt = null
      if (attempt) {
        attempt.freeze()
        await attempt.stop().catch(() => undefined)
      }
    }
  }

  #resolveReady(): void {
    if (this.#readySettled) return
    this.#readySettled = true
    this.#readyResolve()
  }
}
