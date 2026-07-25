import { describe, expect, it } from 'vitest'
import { mediaContentType } from './media-types'

describe('mediaContentType', () => {
  it('maps only the owned playback allowlist', () => {
    expect(mediaContentType('movie.MP4')).toBe('video/mp4')
    expect(mediaContentType('album/song.mp3')).toBe('audio/mpeg')
    expect(mediaContentType('movie.webm')).toBe('video/webm')
    expect(mediaContentType('movie.mkv')).toBe('video/x-matroska')
  })

  it('does not reflect an untrusted extension as a response type', () => {
    expect(mediaContentType('payload.svg')).toBe('application/octet-stream')
    expect(mediaContentType('payload.html')).toBe('application/octet-stream')
  })
})
