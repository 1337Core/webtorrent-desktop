import { parseSync, stringifySync } from 'subtitle'
import { detect } from 'tinyld'

export const SUBTITLE_LIMITS = Object.freeze({
  /** One subtitle file is text; anything larger is not a subtitle file. */
  maxSourceBytes: 2_000_000,
  maxCues: 20_000,
  /** How much cue text the language detector is allowed to look at. */
  maxDetectionChars: 4_000,
  maxLabelChars: 64,
  /** Subtitle tracks offered for one torrent. */
  maxTracks: 8
} as const)

const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'] as const

export type SubtitleErrorCode = 'PARSE_FAILED' | 'TOO_LARGE' | 'UNSUPPORTED'

export class SubtitleError extends Error {
  readonly code: SubtitleErrorCode

  constructor(code: SubtitleErrorCode) {
    super(`Subtitle conversion failed: ${code}.`)
    this.name = 'SubtitleError'
    this.code = code
  }
}

export type SubtitleTrack = Readonly<{
  /** The display name the player shows, e.g. "English". */
  label: string
  /** A BCP 47 primary subtag, or an empty string when detection failed. */
  language: string
  vtt: string
}>

export function isSubtitlePath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return SUBTITLE_EXTENSIONS.some(extension => lower.endsWith(extension))
}

function languageLabel(language: string): string {
  if (language === '') return 'Subtitle'
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' })
    return (names.of(language) ?? language).slice(
      0,
      SUBTITLE_LIMITS.maxLabelChars
    )
  } catch {
    return language.slice(0, SUBTITLE_LIMITS.maxLabelChars)
  }
}

/**
 * Converts one bounded SRT or basic WebVTT file into the WebVTT the player can
 * attach, and names it by its detected language.
 *
 * The parser only ever sees text that already passed the byte bound, and only
 * cues survive: comments, styling, regions, and every other WebVTT construct
 * this release does not claim to support are dropped rather than forwarded.
 */
export function toSubtitleTrack(
  bytes: Uint8Array,
  options: Readonly<{ fallbackLabel?: string }> = {}
): SubtitleTrack {
  if (bytes.byteLength === 0) throw new SubtitleError('UNSUPPORTED')
  if (bytes.byteLength > SUBTITLE_LIMITS.maxSourceBytes) {
    throw new SubtitleError('TOO_LARGE')
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/u, '')
  } catch {
    throw new SubtitleError('UNSUPPORTED')
  }

  let nodes
  try {
    nodes = parseSync(text)
  } catch {
    throw new SubtitleError('PARSE_FAILED')
  }

  const cues = nodes
    .filter(node => node.type === 'cue')
    .slice(0, SUBTITLE_LIMITS.maxCues)
  if (cues.length === 0) throw new SubtitleError('PARSE_FAILED')

  let vtt: string
  try {
    vtt = stringifySync(cues, { format: 'WebVTT' })
  } catch {
    throw new SubtitleError('PARSE_FAILED')
  }

  // Detection reads the dialogue only, so timestamps and cue numbers cannot
  // skew the result.
  const sample = cues
    .map(cue => (typeof cue.data === 'object' ? String(cue.data.text) : ''))
    .join(' ')
    .slice(0, SUBTITLE_LIMITS.maxDetectionChars)
  let language: string
  try {
    language = detect(sample) || ''
  } catch {
    language = ''
  }

  return {
    label:
      language === ''
        ? (options.fallbackLabel ?? 'Subtitle').slice(
            0,
            SUBTITLE_LIMITS.maxLabelChars
          )
        : languageLabel(language),
    language,
    vtt
  }
}

/** Gives every track a distinct name, as the original relabelling did. */
export function relabelTracks<Track extends { label: string }>(
  tracks: ReadonlyArray<Track>
): ReadonlyArray<Track> {
  const counts = new Map<string, number>()
  return tracks.map(track => {
    const seen = (counts.get(track.label) ?? 0) + 1
    counts.set(track.label, seen)
    return seen === 1 ? track : { ...track, label: `${track.label} ${seen}` }
  })
}
