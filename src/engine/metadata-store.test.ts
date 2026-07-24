import { describe, expect, it, vi } from 'vitest'
import { MetadataOnlyChunkStore } from './metadata-store'

describe('MetadataOnlyChunkStore', () => {
  it('never allocates or returns payload chunks', async () => {
    const store = new MetadataOnlyChunkStore(16_384, { length: 1_000_000 })
    expect(store.chunkLength).toBe(16_384)
    expect(store.length).toBe(1_000_000)
    const result = await new Promise<Error | null>(resolve => {
      store.get(0, {}, error => resolve(error))
    })

    expect(result).toMatchObject({ notFound: true })
  })

  it('fails closed if staging attempts to persist payload data', async () => {
    const store = new MetadataOnlyChunkStore(16_384, { length: 1 })
    const result = await new Promise<Error | null | undefined>(resolve => {
      store.put(0, new Uint8Array([1]), error => resolve(error))
    })

    expect(result?.message).toContain('cannot store payload data')
  })

  it('closes asynchronously and rejects subsequent reads', async () => {
    const store = new MetadataOnlyChunkStore(16_384, { length: 1 })
    const callback = vi.fn()

    store.destroy(callback)
    expect(callback).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null))

    const result = await new Promise<Error | null>(resolve => {
      store.get(0, error => resolve(error ?? null))
    })
    expect(result?.message).toContain('closed')
  })

  it.each([
    [0, 1],
    [16_384, -1],
    [Number.NaN, 1]
  ])('rejects invalid geometry (%s, %s)', (chunkLength, length) => {
    expect(
      () => new MetadataOnlyChunkStore(chunkLength, { length })
    ).toThrowError('Invalid metadata-only chunk-store geometry')
  })
})
