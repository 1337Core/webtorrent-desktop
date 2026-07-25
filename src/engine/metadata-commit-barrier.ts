import type { GuardedStoreFault } from './guarded-store'
import {
  canonicalInfoIdentity,
  type ValidatedTorrentMetadata
} from './torrent-metadata'
import type { TorrentReservation } from './torrent-registry'

type CommitBarrierFailureCode =
  | 'FILE_MANIFEST_MISMATCH'
  | 'GEOMETRY_MISMATCH'
  | 'INFO_DICTIONARY_MISMATCH'
  | 'INFO_HASH_MISMATCH'
  | 'NAME_MISMATCH'
  | 'PRIVACY_MISMATCH'
  | 'RESERVATION_MISMATCH'
  | 'STORE_FAULTED'
  | 'UNREADABLE_METADATA'

/**
 * The exact WebTorrent torrent surface the barrier reads at `metadata`. Only
 * fields WebTorrent retains without lossy normalization appear here:
 * reconstructed tracker topology is deliberately absent because
 * `parse-torrent` flattens `announce-list` and `toTorrentFile()` rebuilds
 * singleton tiers.
 */
export type CommitBarrierObservation = Readonly<{
  files: ReadonlyArray<Readonly<{ length: number; path: string }>>
  infoHash: string
  length: number
  name: string
  pieceLength: number
  private: boolean
  torrentFile: Uint8Array
}>

export type CommitBarrierInput = Readonly<{
  expected: ValidatedTorrentMetadata
  observed: CommitBarrierObservation
  reservation: TorrentReservation
  storeFaults?: ReadonlyArray<GuardedStoreFault>
}>

export type CommitBarrierResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      code: CommitBarrierFailureCode
      detail: string
      ok: false
    }>

function failure(
  code: CommitBarrierFailureCode,
  detail: string
): CommitBarrierResult {
  return { code, detail, ok: false }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * The synchronous commit barrier.
 *
 * At `metadata`, WebTorrent has already created the store, file objects,
 * selections, and bitfield, but has not verified any piece. Every identity
 * field is compared here, and a caller that receives a failure must destroy
 * the torrent synchronously so WebTorrent's post-event destroyed check
 * prevents verification. The result carries only fixed, bounded diagnostics.
 */
export function runMetadataCommitBarrier(
  input: CommitBarrierInput
): CommitBarrierResult {
  const { expected, observed, reservation } = input

  const faults = input.storeFaults ?? []
  if (faults.length > 0) {
    return failure('STORE_FAULTED', faults[0]?.code ?? 'unknown')
  }

  if (
    reservation.infoHash !== expected.infoHash ||
    reservation.fileCount !== expected.files.length
  ) {
    return failure('RESERVATION_MISMATCH', 'reservation identity')
  }

  let identity
  try {
    identity = canonicalInfoIdentity(observed.torrentFile)
  } catch (error) {
    return failure(
      'UNREADABLE_METADATA',
      error instanceof Error ? error.name : 'unknown'
    )
  }

  if (
    identity.infoHash !== expected.infoHash ||
    observed.infoHash !== expected.infoHash
  ) {
    return failure('INFO_HASH_MISMATCH', 'canonical info hash')
  }

  let expectedIdentity
  try {
    expectedIdentity = canonicalInfoIdentity(expected.torrentBytes)
  } catch (error) {
    return failure(
      'UNREADABLE_METADATA',
      error instanceof Error ? error.name : 'unknown'
    )
  }
  if (!bytesEqual(identity.infoBytes, expectedIdentity.infoBytes)) {
    return failure('INFO_DICTIONARY_MISMATCH', 'canonical info dictionary')
  }

  if (observed.name !== expected.name) {
    return failure('NAME_MISMATCH', 'canonical name')
  }
  if (observed.private !== expected.private) {
    return failure('PRIVACY_MISMATCH', 'privacy bit')
  }
  if (
    observed.pieceLength !== expected.pieceLength ||
    observed.length !== expected.length
  ) {
    return failure('GEOMETRY_MISMATCH', 'piece geometry')
  }

  if (observed.files.length !== expected.files.length) {
    return failure('FILE_MANIFEST_MISMATCH', 'file count')
  }
  for (const [index, file] of expected.files.entries()) {
    const observedFile = observed.files[index]
    if (
      !observedFile ||
      observedFile.length !== file.length ||
      observedFile.path.split('\\').join('/') !== file.path
    ) {
      return failure('FILE_MANIFEST_MISMATCH', `entry ${index}`)
    }
  }

  return { ok: true }
}
