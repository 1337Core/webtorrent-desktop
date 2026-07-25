export type PieceGeometry = Readonly<{
  pieceCount: number
  pieceLength: number
  totalLength: number
}>

export type SelectionFile = Readonly<{
  index: number
  length: number
  offset: number
}>

export type PieceRange = Readonly<{
  end: number
  start: number
}>

export class PieceSelectionError extends Error {
  readonly code: 'INVALID_GEOMETRY' | 'INVALID_SELECTION'

  constructor(code: PieceSelectionError['code']) {
    super(`Piece selection failed: ${code}.`)
    this.name = 'PieceSelectionError'
    this.code = code
  }
}

function assertGeometry(geometry: PieceGeometry): void {
  if (
    !Number.isSafeInteger(geometry.pieceLength) ||
    geometry.pieceLength < 1 ||
    !Number.isSafeInteger(geometry.pieceCount) ||
    geometry.pieceCount < 0 ||
    !Number.isSafeInteger(geometry.totalLength) ||
    geometry.totalLength < 0 ||
    geometry.pieceCount !==
      (geometry.totalLength === 0
        ? 0
        : Math.ceil(geometry.totalLength / geometry.pieceLength))
  ) {
    throw new PieceSelectionError('INVALID_GEOMETRY')
  }
}

/**
 * Rebuilds the complete desired piece selection from the whole manifest.
 *
 * Adjacent files share boundary pieces and WebTorrent merges selection
 * intervals, so composing individual `file.deselect()` calls can silently
 * cancel a neighbour. Every selection change therefore recomputes the full
 * range list and reapplies it.
 */
export function desiredPieceRanges(
  files: ReadonlyArray<SelectionFile>,
  selectedIndexes: ReadonlyArray<number>,
  geometry: PieceGeometry
): ReadonlyArray<PieceRange> {
  assertGeometry(geometry)

  const known = new Map(files.map(file => [file.index, file]))
  const selected = new Set<number>()
  for (const index of selectedIndexes) {
    if (!known.has(index)) throw new PieceSelectionError('INVALID_SELECTION')
    selected.add(index)
  }

  const ranges: PieceRange[] = []
  for (const file of files) {
    if (!selected.has(file.index) || file.length === 0) continue
    if (
      !Number.isSafeInteger(file.offset) ||
      file.offset < 0 ||
      file.offset + file.length > geometry.totalLength
    ) {
      throw new PieceSelectionError('INVALID_SELECTION')
    }
    ranges.push({
      end: Math.floor((file.offset + file.length - 1) / geometry.pieceLength),
      start: Math.floor(file.offset / geometry.pieceLength)
    })
  }

  ranges.sort((left, right) => left.start - right.start)

  const merged: PieceRange[] = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range.start <= last.end + 1) {
      if (range.end > last.end) {
        merged[merged.length - 1] = { end: range.end, start: last.start }
      }
      continue
    }
    merged.push(range)
  }
  return merged
}

export function pieceRangesEqual(
  left: ReadonlyArray<PieceRange>,
  right: ReadonlyArray<PieceRange>
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.start === right[index]?.start && range.end === right[index]?.end
    )
  )
}
