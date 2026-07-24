import { createHash } from 'node:crypto'
import bencode from 'bencode'
import { describe, expect, it } from 'vitest'
import { scanStrictTorrentBencode, StrictBencodeError } from './strict-bencode'

function minimalTorrent(): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    info: {
      length: 1,
      name: 'a',
      'piece length': 16_384,
      pieces: new Uint8Array(20)
    }
  })
}

describe('scanStrictTorrentBencode', () => {
  it('returns the exact raw info dictionary slice', () => {
    const bytes = minimalTorrent()
    const result = scanStrictTorrentBencode(bytes)
    const rawInfo = bytes.subarray(result.infoStart, result.infoEnd)

    expect(new TextDecoder().decode(rawInfo)).toBe(
      'd6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:' +
        '\u0000'.repeat(20) +
        'e'
    )
    expect(createHash('sha1').update(rawInfo).digest('hex')).toHaveLength(40)
  })

  it.each([
    ['duplicate key', 'd4:infod1:a1:x1:a1:yee', 'DUPLICATE_KEY'],
    ['unsorted key', 'd4:infod1:b1:x1:a1:yee', 'DICTIONARY_ORDER'],
    ['leading-zero integer', 'd4:infod1:ai01eee', 'INVALID_INTEGER'],
    ['negative zero', 'd4:infod1:ai-0eee', 'INVALID_INTEGER'],
    [
      'leading-zero string length',
      'd4:infod1:a01:xee',
      'INVALID_STRING_LENGTH'
    ],
    ['trailing bytes', 'd4:infodeejunk', 'TRAILING_DATA'],
    ['missing info', 'd1:a1:xe', 'INFO_MISSING'],
    ['non-dictionary info', 'd4:info1:xe', 'INFO_NOT_DICTIONARY']
  ])('rejects %s', (_label, source, code) => {
    expect(() =>
      scanStrictTorrentBencode(new TextEncoder().encode(source))
    ).toThrowError(expect.objectContaining({ code }))
  })

  it('rejects excessive nesting before recursion becomes unsafe', () => {
    const nested = `d4:infod1:a${'l'.repeat(34)}${'e'.repeat(34)}ee`

    expect(() =>
      scanStrictTorrentBencode(new TextEncoder().encode(nested))
    ).toThrowError(StrictBencodeError)
    expect(() =>
      scanStrictTorrentBencode(new TextEncoder().encode(nested))
    ).toThrowError(expect.objectContaining({ code: 'DEPTH_LIMIT' }))
  })

  it('rejects oversized input before scanning it', () => {
    expect(() =>
      scanStrictTorrentBencode(new Uint8Array(10_000_001))
    ).toThrowError(expect.objectContaining({ code: 'SIZE_LIMIT' }))
  })

  it('rejects excessive values within the byte limit', () => {
    const source = `d4:infod1:al${'0:'.repeat(1_000_000)}eee`

    expect(() =>
      scanStrictTorrentBencode(new TextEncoder().encode(source))
    ).toThrowError(expect.objectContaining({ code: 'VALUE_LIMIT' }))
  })

  it.each([
    [
      'oversized integer token',
      'd4:infod1:ai12345678901234567eee',
      'INVALID_INTEGER'
    ],
    [
      'oversized string-length token',
      'd4:infod1:a100000000:xee',
      'INVALID_STRING_LENGTH'
    ]
  ])('caps digit parsing for %s', (_label, source, code) => {
    expect(() =>
      scanStrictTorrentBencode(new TextEncoder().encode(source))
    ).toThrowError(expect.objectContaining({ code }))
  })
})
