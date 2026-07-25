import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ExternalSubtitleGrant } from '../shared/engine-api'
import {
  isSubtitlePath,
  SUBTITLE_LIMITS,
  toSubtitleTrack,
  type SubtitleTrack
} from './subtitles'

export type ExternalSubtitleErrorCode =
  | 'CHANGED_DURING_READ'
  | 'NOT_A_FILE'
  | 'TOO_LARGE'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'

export class ExternalSubtitleError extends Error {
  readonly code: ExternalSubtitleErrorCode

  constructor(code: ExternalSubtitleErrorCode) {
    super(`External subtitle read failed: ${code}.`)
    this.name = 'ExternalSubtitleError'
    this.code = code
  }
}

function parentPaths(filePath: string): string[] {
  const root = path.parse(filePath).root
  const result: string[] = []
  let current = path.dirname(filePath)
  while (current !== root) {
    result.push(current)
    current = path.dirname(current)
  }
  return result.reverse()
}

function matchesFileIdentity(
  stats: Readonly<{
    dev: bigint
    ino: bigint
    mtimeNs: bigint
    size: bigint
  }>,
  identity: ExternalSubtitleGrant['file']
): boolean {
  return (
    stats.dev.toString() === identity.device &&
    stats.ino.toString() === identity.inode &&
    stats.mtimeNs.toString() === identity.modifiedNs &&
    stats.size.toString() === identity.size
  )
}

async function verifyGrant(
  filePath: string,
  grant: ExternalSubtitleGrant
): Promise<void> {
  let canonicalPath: string
  try {
    canonicalPath = await realpath(filePath)
  } catch {
    throw new ExternalSubtitleError('UNAVAILABLE')
  }
  if (canonicalPath !== grant.canonicalPath) {
    throw new ExternalSubtitleError('UNAVAILABLE')
  }

  const expectedParents = parentPaths(grant.canonicalPath)
  if (
    expectedParents.length !== grant.parentChain.length ||
    expectedParents.some(
      (parentPath, index) => grant.parentChain[index]?.path !== parentPath
    )
  ) {
    throw new ExternalSubtitleError('UNAVAILABLE')
  }

  try {
    for (const expected of grant.parentChain) {
      const current = await lstat(expected.path, { bigint: true })
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev.toString() !== expected.device ||
        current.ino.toString() !== expected.inode
      ) {
        throw new ExternalSubtitleError('UNAVAILABLE')
      }
    }
  } catch (error) {
    if (error instanceof ExternalSubtitleError) throw error
    throw new ExternalSubtitleError('UNAVAILABLE')
  }
}

/**
 * Reads exactly one file the native chooser authorized.
 *
 * The descriptor is opened without following a final symlink and every byte
 * is read into a fixed-size buffer, so a file that grows after the first stat
 * cannot turn the chooser grant into an unbounded allocation.
 */
export async function readExternalSubtitle(
  filePath: string,
  grant: ExternalSubtitleGrant
): Promise<SubtitleTrack> {
  if (!path.isAbsolute(filePath) || !isSubtitlePath(filePath)) {
    throw new ExternalSubtitleError('UNSUPPORTED')
  }

  await verifyGrant(filePath, grant)

  let handle
  try {
    handle = await open(
      grant.canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    )
  } catch {
    throw new ExternalSubtitleError('UNAVAILABLE')
  }

  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new ExternalSubtitleError('NOT_A_FILE')
    if (!matchesFileIdentity(before, grant.file)) {
      throw new ExternalSubtitleError('UNAVAILABLE')
    }
    if (before.size > BigInt(SUBTITLE_LIMITS.maxSourceBytes)) {
      throw new ExternalSubtitleError('TOO_LARGE')
    }

    const bytes = new Uint8Array(SUBTITLE_LIMITS.maxSourceBytes + 1)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > SUBTITLE_LIMITS.maxSourceBytes) {
      throw new ExternalSubtitleError('TOO_LARGE')
    }

    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(offset) !== after.size
    ) {
      throw new ExternalSubtitleError('CHANGED_DURING_READ')
    }

    return toSubtitleTrack(bytes.subarray(0, offset), {
      fallbackLabel: path.basename(filePath)
    })
  } finally {
    await handle.close().catch(() => undefined)
  }
}
