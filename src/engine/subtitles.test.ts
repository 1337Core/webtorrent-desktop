import { describe, expect, it } from 'vitest'
import {
  isSubtitlePath,
  relabelTracks,
  SUBTITLE_LIMITS,
  SubtitleError,
  toSubtitleTrack
} from './subtitles'

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Good evening, and welcome to the show.',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  'Tonight we look at how the harbour was built.',
  ''
].join('\n')

const GERMAN_SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,000',
  'Guten Abend und willkommen zur Sendung.',
  '',
  '2',
  '00:00:05,000 --> 00:00:08,000',
  'Heute Abend sehen wir uns an, wie der Hafen gebaut wurde.',
  ''
].join('\n')

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

describe('toSubtitleTrack', () => {
  it('converts SRT to WebVTT and names it by its language', () => {
    const track = toSubtitleTrack(bytes(SRT))

    expect(track.vtt.startsWith('WEBVTT')).toBe(true)
    expect(track.vtt).toContain('00:00:01.000 --> 00:00:04.000')
    expect(track.vtt).toContain('Good evening, and welcome to the show.')
    expect(track.language).toBe('en')
    expect(track.label).toBe('English')
  })

  it('detects a different language from the dialogue alone', () => {
    const track = toSubtitleTrack(bytes(GERMAN_SRT))

    expect(track.language).toBe('de')
    expect(track.label).toBe('German')
  })

  it('accepts WebVTT the release supports and drops what it does not', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this comment is not a cue',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'Only the cue survives.',
      ''
    ].join('\n')

    const track = toSubtitleTrack(bytes(vtt))

    expect(track.vtt).toContain('Only the cue survives.')
    expect(track.vtt).not.toContain('this comment is not a cue')
  })

  it('strips a byte order mark before parsing', () => {
    const track = toSubtitleTrack(bytes(`\uFEFF${SRT}`))

    expect(track.vtt).toContain('Good evening, and welcome to the show.')
  })

  it('refuses an empty, oversized, or non-text file', () => {
    expect(() => toSubtitleTrack(new Uint8Array())).toThrow(SubtitleError)
    expect(() =>
      toSubtitleTrack(new Uint8Array(SUBTITLE_LIMITS.maxSourceBytes + 1))
    ).toThrow(SubtitleError)
    expect(() => toSubtitleTrack(new Uint8Array([0xff, 0xfe, 0xff]))).toThrow(
      SubtitleError
    )
  })

  it('refuses text that holds no cue at all', () => {
    expect(() => toSubtitleTrack(bytes('not a subtitle file'))).toThrow(
      SubtitleError
    )
  })

  it('falls back to a caller-supplied name when detection finds nothing', () => {
    const numeric = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      '1234567890',
      ''
    ].join('\n')

    const track = toSubtitleTrack(bytes(numeric), {
      fallbackLabel: 'movie.en.srt'
    })

    expect(track.label.length).toBeLessThanOrEqual(
      SUBTITLE_LIMITS.maxLabelChars
    )
    expect(track.vtt).toContain('1234567890')
  })
})

describe('isSubtitlePath', () => {
  it('recognizes only the two supported extensions', () => {
    expect(isSubtitlePath('payload/movie.en.srt')).toBe(true)
    expect(isSubtitlePath('payload/MOVIE.VTT')).toBe(true)
    expect(isSubtitlePath('payload/movie.mp4')).toBe(false)
    expect(isSubtitlePath('payload/srt')).toBe(false)
  })
})

describe('relabelTracks', () => {
  it('numbers repeated labels so no two tracks read alike', () => {
    const track = { label: 'English', language: 'en', vtt: 'WEBVTT' }

    expect(
      relabelTracks([track, track, { ...track, label: 'German' }]).map(
        entry => entry.label
      )
    ).toEqual(['English', 'English 2', 'German'])
  })
})
