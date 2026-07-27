import { describe, expect, it } from 'vitest'
import {
  desiredPieceRanges,
  pieceRangesEqual,
  PieceSelectionError,
  type PieceGeometry,
  type SelectionFile
} from './piece-selection'

const PIECE_LENGTH = 16

function manifest(lengths: ReadonlyArray<number>): {
  files: SelectionFile[]
  geometry: PieceGeometry
} {
  let offset = 0
  const files = lengths.map((length, index) => {
    const file = { index, length, offset }
    offset += length
    return file
  })
  return {
    files,
    geometry: {
      pieceCount: offset === 0 ? 0 : Math.ceil(offset / PIECE_LENGTH),
      pieceLength: PIECE_LENGTH,
      totalLength: offset
    }
  }
}

describe('desiredPieceRanges', () => {
  it('selects nothing when no file is selected', () => {
    const { files, geometry } = manifest([32, 32])
    expect(desiredPieceRanges(files, [], geometry)).toEqual([])
  })

  it('covers the whole piece span of one selected file', () => {
    const { files, geometry } = manifest([40])
    expect(desiredPieceRanges(files, [0], geometry)).toEqual([
      { end: 2, start: 0 }
    ])
  })

  it('keeps a shared boundary piece selected for either neighbour', () => {
    // 20 bytes then 20 bytes with 16-byte pieces: piece 1 holds the tail of
    // the first file and the head of the second.
    const { files, geometry } = manifest([20, 20])

    expect(desiredPieceRanges(files, [0], geometry)).toEqual([
      { end: 1, start: 0 }
    ])
    expect(desiredPieceRanges(files, [1], geometry)).toEqual([
      { end: 2, start: 1 }
    ])
    expect(desiredPieceRanges(files, [0, 1], geometry)).toEqual([
      { end: 2, start: 0 }
    ])
  })

  it('merges adjacent ranges and keeps a gap between distant files', () => {
    const { files, geometry } = manifest([16, 16, 64, 16])

    expect(desiredPieceRanges(files, [0, 1], geometry)).toEqual([
      { end: 1, start: 0 }
    ])
    expect(desiredPieceRanges(files, [0, 3], geometry)).toEqual([
      { end: 0, start: 0 },
      { end: 6, start: 6 }
    ])
  })

  it('ignores zero-length files, which own no piece', () => {
    const { files, geometry } = manifest([16, 0, 16])
    expect(desiredPieceRanges(files, [1], geometry)).toEqual([])
    expect(desiredPieceRanges(files, [0, 1, 2], geometry)).toEqual([
      { end: 1, start: 0 }
    ])
  })

  it('rejects an unknown selection index and inconsistent geometry', () => {
    const { files, geometry } = manifest([16])

    expect(() => desiredPieceRanges(files, [7], geometry)).toThrow(
      PieceSelectionError
    )
    expect(() =>
      desiredPieceRanges(files, [0], { ...geometry, pieceCount: 9 })
    ).toThrow(expect.objectContaining({ code: 'INVALID_GEOMETRY' }) as Error)
    expect(() =>
      desiredPieceRanges([{ index: 0, length: 32, offset: 0 }], [0], {
        ...geometry
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_SELECTION' }) as Error)
  })

  it('compares two rebuilt selections', () => {
    const { files, geometry } = manifest([20, 20])
    const first = desiredPieceRanges(files, [0, 1], geometry)
    const second = desiredPieceRanges(files, [1, 0], geometry)

    expect(pieceRangesEqual(first, second)).toBe(true)
    expect(
      pieceRangesEqual(first, desiredPieceRanges(files, [0], geometry))
    ).toBe(false)
  })
})
