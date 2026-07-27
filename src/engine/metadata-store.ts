import type { ChunkStore, ChunkStoreCallback } from 'webtorrent'

type MissingChunkError = Error & { notFound: true }

function missingChunkError(): MissingChunkError {
  const error = new Error('Metadata staging contains no payload pieces')
  return Object.assign(error, { notFound: true as const })
}

/**
 * Metadata exchange completes before WebTorrent emits `metadata`, but
 * WebTorrent constructs a chunk store first. This store satisfies that
 * boundary without allocating or persisting any payload piece.
 */
export class MetadataOnlyChunkStore implements ChunkStore {
  readonly chunkLength: number
  readonly length: number
  #closed = false

  constructor(chunkLength: number, options: { length: number }) {
    if (
      !Number.isSafeInteger(chunkLength) ||
      chunkLength <= 0 ||
      !Number.isSafeInteger(options.length) ||
      options.length < 0
    ) {
      throw new Error('Invalid metadata-only chunk-store geometry')
    }
    this.chunkLength = chunkLength
    this.length = options.length
  }

  close(callback: ChunkStoreCallback = () => undefined): void {
    this.#finish(callback)
  }

  destroy(callback: ChunkStoreCallback = () => undefined): void {
    this.#finish(callback)
  }

  get(
    _index: number,
    options:
      | {
          length?: number
          offset?: number
        }
      | ChunkStoreCallback,
    callback?: (error: Error | null, data?: Uint8Array) => void
  ): void {
    const resultCallback =
      typeof options === 'function' ? options : (callback ?? (() => undefined))
    queueMicrotask(() => {
      resultCallback(
        this.#closed
          ? new Error('Metadata-only chunk store is closed')
          : missingChunkError()
      )
    })
  }

  put(
    _index: number,
    _data: Uint8Array,
    callback: ChunkStoreCallback = () => undefined
  ): void {
    queueMicrotask(() => {
      callback(
        new Error(
          `Metadata staging cannot store payload data (${this.chunkLength}/${this.length})`
        )
      )
    })
  }

  #finish(callback: ChunkStoreCallback): void {
    if (this.#closed) {
      queueMicrotask(() =>
        callback(new Error('Metadata-only chunk store is already closed'))
      )
      return
    }
    this.#closed = true
    queueMicrotask(() => callback(null))
  }
}
