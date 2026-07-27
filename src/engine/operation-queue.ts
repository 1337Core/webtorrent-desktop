export class EngineQueueClosedError extends Error {
  constructor() {
    super('The torrent engine is shutting down.')
    this.name = 'EngineQueueClosedError'
  }
}

export class EngineOperationAbortedError extends Error {
  constructor() {
    super('The torrent engine operation was aborted.')
    this.name = 'EngineOperationAbortedError'
  }
}

type QueuedOperation<T> = (signal: AbortSignal) => Promise<T> | T

/**
 * Serializes lifecycle work for one torrent without blocking control traffic.
 * Every admitted operation is abortable, and shutdown prevents new admission
 * before it drains the promises that were already returned to callers.
 */
export class EngineOperationQueue {
  readonly #controller = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  readonly #tails = new Map<string, Promise<void>>()
  #closed = false

  run<T>(
    key: string,
    operation: QueuedOperation<T>,
    externalSignal?: AbortSignal
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new EngineQueueClosedError())

    const signal = externalSignal
      ? AbortSignal.any([this.#controller.signal, externalSignal])
      : this.#controller.signal
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (this.#controller.signal.aborted) {
        throw new EngineQueueClosedError()
      }
      if (signal.aborted) {
        throw new EngineOperationAbortedError()
      }
      return await operation(signal)
    })
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.#tails.set(key, tail)
    this.#pending.add(result)
    void tail.then(() => {
      this.#pending.delete(result)
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return result
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#controller.abort()
  }

  async drain(): Promise<void> {
    await Promise.all(
      Array.from(this.#pending, promise =>
        promise.then(
          () => undefined,
          () => undefined
        )
      )
    )
  }

  get closed(): boolean {
    return this.#closed
  }

  get pendingCount(): number {
    return this.#pending.size
  }
}
