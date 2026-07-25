import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { IAudioMetadata } from 'music-metadata'
import {
  AUDIO_METADATA_LIMITS,
  inspectAudioMetadata,
  proveAudioMetadataRuntime,
  type AudioMetadataSource
} from './audio-metadata'
import { EngineOperationQueue } from './operation-queue'

function metadata(overrides: Partial<IAudioMetadata> = {}): IAudioMetadata {
  return {
    common: {
      disk: { no: null, of: null },
      movementIndex: { no: null, of: null },
      track: { no: null, of: null }
    },
    format: { tagTypes: [], trackInfo: [] },
    native: {},
    quality: { warnings: [] },
    ...overrides
  }
}

function source(bytes: Uint8Array, name = 'track.mp3'): AudioMetadataSource {
  return {
    createReadStream: () => Readable.from([bytes]),
    length: bytes.byteLength,
    name
  }
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  bytes.set([73, 72, 68, 82], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function jpeg(width: number, height: number, length = 11): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8])
  const view = new DataView(bytes.buffer)
  view.setUint16(7, height)
  view.setUint16(9, width)
  return bytes
}

describe('inspectAudioMetadata', () => {
  it('returns only bounded, cleaned metadata fields', async () => {
    const parse = vi.fn(async () =>
      metadata({
        common: {
          album: ' Album ',
          albumartist: 'Album Artist',
          artist: `Artist\u0000${'x'.repeat(600)}`,
          disk: { no: 1, of: 2 },
          movementIndex: { no: null, of: null },
          title: 'Title',
          track: { no: 3, of: 10 },
          year: 2024
        },
        format: {
          bitrate: 320_000,
          bitsPerSample: 24,
          codec: 'MPEG Layer 3',
          container: 'MPEG',
          sampleRate: 48_000,
          tagTypes: [],
          trackInfo: []
        }
      })
    )

    const result = await inspectAudioMetadata(
      source(new Uint8Array([1, 2, 3])),
      new AbortController().signal,
      parse as never
    )

    expect(result.metadata).toMatchObject({
      album: 'Album',
      artist: expect.not.stringContaining('\u0000'),
      bitrate: 320_000,
      title: 'Title',
      track: { no: 3, of: 10 },
      year: 2024
    })
    expect(
      new TextEncoder().encode(result.metadata.artist ?? '').byteLength
    ).toBeLessThanOrEqual(AUDIO_METADATA_LIMITS.maxTextBytes)
    expect(JSON.stringify(result)).not.toContain('native')
  })

  it('accepts only bounded, dimension-checked PNG or JPEG artwork', async () => {
    const valid = png(600, 600)
    const hugeDimensions = png(50_000, 50_000)
    const parse = vi.fn(async () =>
      metadata({
        common: {
          disk: { no: null, of: null },
          movementIndex: { no: null, of: null },
          picture: [
            { data: hugeDimensions, format: 'image/png' },
            { data: valid, format: 'text/html' }
          ],
          track: { no: null, of: null }
        }
      })
    )

    const result = await inspectAudioMetadata(
      source(new Uint8Array([1])),
      new AbortController().signal,
      parse as never
    )

    expect(result.artwork).toMatchObject({
      contentType: 'image/png',
      height: 600,
      width: 600
    })
    expect(result.artwork?.bytes).toEqual(valid)
  })

  it('accepts JPEG dimensions and the exact 2 MiB artwork boundary', async () => {
    const exact = jpeg(800, 600, AUDIO_METADATA_LIMITS.maxArtworkBytes)
    const parse = vi.fn(async () =>
      metadata({
        common: {
          disk: { no: null, of: null },
          movementIndex: { no: null, of: null },
          picture: [
            {
              data: jpeg(800, 600, AUDIO_METADATA_LIMITS.maxArtworkBytes + 1),
              format: 'image/jpeg'
            },
            { data: exact, format: 'image/jpeg' }
          ],
          track: { no: null, of: null }
        }
      })
    )

    const result = await inspectAudioMetadata(
      source(new Uint8Array([1])),
      new AbortController().signal,
      parse as never
    )

    expect(result.artwork).toMatchObject({
      contentType: 'image/jpeg',
      height: 600,
      width: 800
    })
    expect(result.artwork?.bytes.byteLength).toBe(
      AUDIO_METADATA_LIMITS.maxArtworkBytes
    )
  })

  it('ignores artwork after the eighth picture', async () => {
    const parse = vi.fn(async () =>
      metadata({
        common: {
          disk: { no: null, of: null },
          movementIndex: { no: null, of: null },
          picture: [
            ...Array.from({ length: 8 }, () => ({
              data: new Uint8Array([0]),
              format: 'image/png'
            })),
            { data: png(320, 240), format: 'image/png' }
          ],
          track: { no: null, of: null }
        }
      })
    )

    const result = await inspectAudioMetadata(
      source(new Uint8Array([1])),
      new AbortController().signal,
      parse as never
    )

    expect(result.artwork).toBeNull()
  })

  it('omits hostile non-finite and oversized numeric metadata', async () => {
    const parse = vi.fn(async () =>
      metadata({
        common: {
          disk: { no: Number.NaN, of: Number.MAX_SAFE_INTEGER },
          movementIndex: { no: null, of: null },
          track: { no: Number.POSITIVE_INFINITY, of: 1_000_001 },
          year: Number.MAX_SAFE_INTEGER
        },
        format: {
          bitrate: Number.NaN,
          bitsPerSample: 129,
          sampleRate: Number.POSITIVE_INFINITY,
          tagTypes: [],
          trackInfo: []
        }
      })
    )

    const result = await inspectAudioMetadata(
      source(new Uint8Array([1])),
      new AbortController().signal,
      parse as never
    )

    expect(result.metadata).toMatchObject({
      bitrate: null,
      bitsPerSample: null,
      disk: { no: null, of: null },
      sampleRate: null,
      track: { no: null, of: null },
      year: null
    })
  })

  it('stops parser input at the exact scan ceiling', async () => {
    let received = 0
    const parse = vi.fn(async (input: Readable) => {
      for await (const chunk of input) {
        received += (chunk as Uint8Array).byteLength
      }
      return metadata()
    })

    const exact = await inspectAudioMetadata(
      source(new Uint8Array(AUDIO_METADATA_LIMITS.maxScanBytes)),
      new AbortController().signal,
      parse as never
    )
    expect(exact.metadata.title).toBe('track.mp3')
    expect(received).toBe(AUDIO_METADATA_LIMITS.maxScanBytes)

    received = 0
    const over = await inspectAudioMetadata(
      source(new Uint8Array(AUDIO_METADATA_LIMITS.maxScanBytes + 1)),
      new AbortController().signal,
      parse as never
    )
    expect(over).toEqual({
      artwork: null,
      metadata: expect.objectContaining({ title: 'track.mp3' })
    })
    expect(received).toBe(0)
  })

  it('keeps malformed metadata and aborted work non-fatal to playback', async () => {
    const parse = vi.fn(async () => {
      throw new Error('bad tags')
    })
    const controller = new AbortController()
    controller.abort()

    expect(
      await inspectAudioMetadata(
        source(new Uint8Array([1]), 'fallback.wav'),
        controller.signal,
        parse as never
      )
    ).toEqual({
      artwork: null,
      metadata: expect.objectContaining({ title: 'fallback.wav' })
    })
    expect(parse).not.toHaveBeenCalled()
  })

  it('returns fallback metadata without opening a zero-length source', async () => {
    const createReadStream = vi.fn(() => {
      throw new Error('invalid -1 end range')
    })
    const parse = vi.fn(async () => metadata())

    await expect(
      inspectAudioMetadata(
        { createReadStream, length: 0, name: 'empty.mp3' },
        new AbortController().signal,
        parse as never
      )
    ).resolves.toEqual({
      artwork: null,
      metadata: expect.objectContaining({ title: 'empty.mp3' })
    })
    expect(createReadStream).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
  })

  it('destroys an active source stream when metadata work is aborted', async () => {
    const input = new Readable({ read() {} })
    const active = Promise.withResolvers<void>()
    const parse = vi.fn(async (stream: Readable) => {
      active.resolve()
      for await (const chunk of stream) {
        // The stream intentionally remains active until abort destroys it.
        void chunk
      }
      return metadata()
    })
    const controller = new AbortController()
    const inspection = inspectAudioMetadata(
      {
        createReadStream: () => input,
        length: 1,
        name: 'active.mp3'
      },
      controller.signal,
      parse as never
    )

    await active.promise
    controller.abort()

    await expect(inspection).resolves.toEqual({
      artwork: null,
      metadata: expect.objectContaining({ title: 'active.mp3' })
    })
    expect(input.destroyed).toBe(true)
  })

  it('releases the serialized queue at its own deadline and destroys input', async () => {
    const input = new Readable({ read() {} })
    const parserStarted = Promise.withResolvers<void>()
    const queue = new EngineOperationQueue()
    const first = queue.run('torrent', signal =>
      inspectAudioMetadata(
        {
          createReadStream: () => input,
          length: 1,
          name: 'stalled.mp3'
        },
        signal,
        (async () => {
          parserStarted.resolve()
          return await new Promise<IAudioMetadata>(() => undefined)
        }) as never,
        { timeoutMs: 25 }
      )
    )
    await parserStarted.promise

    const second = queue.run('torrent', async () => 'released')

    await expect(first).resolves.toEqual({
      artwork: null,
      metadata: expect.objectContaining({ title: 'stalled.mp3' })
    })
    await expect(second).resolves.toBe('released')
    expect(input.destroyed).toBe(true)
    expect(queue.pendingCount).toBe(0)
  })

  it('exercises the real externalized parseStream export on a valid WAV', async () => {
    await expect(proveAudioMetadataRuntime()).resolves.toBe(
      'music-metadata.parseStream'
    )
  })
})
