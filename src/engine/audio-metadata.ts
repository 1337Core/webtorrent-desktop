import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { parseStream, type IAudioMetadata, type IPicture } from 'music-metadata'
import { mediaContentType } from './media-types'

export const AUDIO_METADATA_LIMITS = Object.freeze({
  maxInspectionMs: 4_000,
  maxArtworkBytes: 2 * 1024 * 1024,
  maxDimension: 8_192,
  maxPictures: 8,
  maxPixels: 16_777_216,
  maxScanBytes: 8 * 1024 * 1024,
  maxTextBytes: 256
})

type BoundedAudioMetadata = Readonly<{
  album: string | null
  albumArtist: string | null
  artist: string | null
  bitrate: number | null
  bitsPerSample: number | null
  codec: string | null
  container: string | null
  disk: Readonly<{ no: number | null; of: number | null }>
  sampleRate: number | null
  title: string
  track: Readonly<{ no: number | null; of: number | null }>
  year: number | null
}>

type BoundedArtwork = Readonly<{
  bytes: Uint8Array
  contentType: 'image/jpeg' | 'image/png'
  height: number
  width: number
}>

export type AudioMetadataInspection = Readonly<{
  artwork: BoundedArtwork | null
  metadata: BoundedAudioMetadata
}>

export type AudioMetadataSource = Readonly<{
  createReadStream: () => Readable
  length: number
  name: string
}>

type ParseAudio = typeof parseStream
const encoder = new TextEncoder()

function boundedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = Array.from(value.trim())
    .filter(character => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127
    })
    .join('')
  if (cleaned === '') return null

  let end = cleaned.length
  while (
    end > 0 &&
    encoder.encode(cleaned.slice(0, end)).byteLength >
      AUDIO_METADATA_LIMITS.maxTextBytes
  ) {
    end -= 1
  }
  return cleaned.slice(0, end) || null
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null
}

function dimensions(bytes: Uint8Array): Readonly<{
  contentType: 'image/jpeg' | 'image/png'
  height: number
  width: number
}> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const png = [137, 80, 78, 71, 13, 10, 26, 10]
  if (
    bytes.byteLength >= 24 &&
    png.every((value, index) => bytes[index] === value) &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
  ) {
    return {
      contentType: 'image/png',
      height: view.getUint32(20),
      width: view.getUint32(16)
    }
  }

  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let offset = 2
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    offset += 1
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) return null
    const length = view.getUint16(offset)
    if (length < 2 || offset + length > bytes.byteLength) return null
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf
      ].includes(marker)
    ) {
      if (length < 7) return null
      return {
        contentType: 'image/jpeg',
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5)
      }
    }
    offset += length
  }
  return null
}

function boundedArtwork(
  pictures: readonly IPicture[] | undefined
): BoundedArtwork | null {
  for (const picture of (pictures ?? []).slice(
    0,
    AUDIO_METADATA_LIMITS.maxPictures
  )) {
    if (
      picture.data.byteLength === 0 ||
      picture.data.byteLength > AUDIO_METADATA_LIMITS.maxArtworkBytes
    ) {
      continue
    }
    const size = dimensions(picture.data)
    if (
      !size ||
      size.width < 1 ||
      size.height < 1 ||
      size.width > AUDIO_METADATA_LIMITS.maxDimension ||
      size.height > AUDIO_METADATA_LIMITS.maxDimension ||
      size.width * size.height > AUDIO_METADATA_LIMITS.maxPixels
    ) {
      continue
    }
    return {
      bytes: new Uint8Array(picture.data),
      contentType: size.contentType,
      height: size.height,
      width: size.width
    }
  }
  return null
}

function fallback(name: string): BoundedAudioMetadata {
  return {
    album: null,
    albumArtist: null,
    artist: null,
    bitrate: null,
    bitsPerSample: null,
    codec: null,
    container: null,
    disk: { no: null, of: null },
    sampleRate: null,
    title: boundedText(path.basename(name)) ?? 'Audio',
    track: { no: null, of: null },
    year: null
  }
}

function sanitize(parsed: IAudioMetadata, name: string): BoundedAudioMetadata {
  const common = parsed.common
  const format = parsed.format
  return {
    album: boundedText(common.album),
    albumArtist: boundedText(common.albumartist),
    artist: boundedText(common.artist),
    bitrate: boundedNumber(format.bitrate, 1, 10_000_000),
    bitsPerSample: boundedInteger(format.bitsPerSample, 1, 128),
    codec: boundedText(format.codec),
    container: boundedText(format.container),
    disk: {
      no: boundedInteger(common.disk.no, 1, 1_000_000),
      of: boundedInteger(common.disk.of, 1, 1_000_000)
    },
    sampleRate: boundedNumber(format.sampleRate, 1, 1_000_000),
    title: boundedText(common.title) ?? fallback(name).title,
    track: {
      no: boundedInteger(common.track.no, 1, 1_000_000),
      of: boundedInteger(common.track.of, 1, 1_000_000)
    },
    year: boundedInteger(common.year, 1_000, 9_999)
  }
}

function limitedStream(source: Readable, signal: AbortSignal): Transform {
  let seen = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.byteLength
      if (seen > AUDIO_METADATA_LIMITS.maxScanBytes) {
        callback(new Error('AUDIO_METADATA_TOO_LARGE'))
        return
      }
      callback(null, chunk)
    }
  })
  const abort = (): void => {
    source.destroy()
    limit.destroy()
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  limit.once('close', () => signal.removeEventListener('abort', abort))
  source.pipe(limit)
  return limit
}

function waveFixture(): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  view.setUint32(4, bytes.byteLength - 8, true)
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8_000, true)
  view.setUint32(28, 8_000, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  bytes.set(new TextEncoder().encode('data'), 36)
  view.setUint32(40, 2, true)
  bytes.set([128, 128], 44)
  return bytes
}

/**
 * Extracts a small, owned metadata shape and at most one bounded raster image.
 * Parser errors are intentionally non-fatal to playback.
 */
export async function inspectAudioMetadata(
  source: AudioMetadataSource,
  signal: AbortSignal,
  parse: ParseAudio = parseStream,
  options: Readonly<{ timeoutMs?: number }> = {}
): Promise<AudioMetadataInspection> {
  if (signal.aborted) {
    return { artwork: null, metadata: fallback(source.name) }
  }
  if (source.length <= 0) {
    return { artwork: null, metadata: fallback(source.name) }
  }

  let input: Readable | null = null
  let removeAbortGate = (): void => undefined
  const timeoutMs = options.timeoutMs ?? AUDIO_METADATA_LIMITS.maxInspectionMs
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > AUDIO_METADATA_LIMITS.maxInspectionMs
  ) {
    throw new RangeError('Audio metadata deadline is outside its fixed range')
  }
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  timer.unref()
  const inspectionSignal = AbortSignal.any([signal, deadline.signal])
  try {
    input = source.createReadStream()
    const parserInput = limitedStream(input, inspectionSignal)
    const parseResult = Promise.resolve().then(() =>
      parse(
        parserInput,
        {
          mimeType: mediaContentType(source.name),
          path: source.name,
          size: source.length
        },
        {
          duration: false,
          includeChapters: false,
          skipCovers: false,
          skipPostHeaders: true
        }
      )
    )
    const abortGate = new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(new Error('AUDIO_METADATA_ABORTED'))
      if (inspectionSignal.aborted) {
        abort()
        return
      }
      inspectionSignal.addEventListener('abort', abort, { once: true })
      removeAbortGate = () =>
        inspectionSignal.removeEventListener('abort', abort)
    })
    const parsed = await Promise.race([parseResult, abortGate])
    return {
      artwork: boundedArtwork(parsed.common.picture),
      metadata: sanitize(parsed, source.name)
    }
  } catch {
    return { artwork: null, metadata: fallback(source.name) }
  } finally {
    clearTimeout(timer)
    removeAbortGate()
    input?.destroy()
  }
}

/**
 * Startup proof for the exact Node-conditioned export used in packaged builds.
 * A failure is fatal during engine initialization rather than surfacing later
 * when the first real audio file is opened.
 */
export async function proveAudioMetadataRuntime(): Promise<'music-metadata.parseStream'> {
  const bytes = waveFixture()
  const parsed = await parseStream(
    Readable.from([Buffer.from(bytes)], { objectMode: false }),
    {
      mimeType: 'audio/wav',
      path: 'runtime-proof.wav',
      size: bytes.byteLength
    },
    {
      duration: false,
      includeChapters: false,
      skipCovers: true,
      skipPostHeaders: true
    }
  )
  if (parsed.format.sampleRate !== 8_000 || parsed.format.bitsPerSample !== 8) {
    throw new Error('AUDIO_METADATA_RUNTIME_UNAVAILABLE')
  }
  return 'music-metadata.parseStream'
}
