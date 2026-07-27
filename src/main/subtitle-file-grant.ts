import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ExternalSubtitleGrant } from '../shared/engine-api'

type BigIdentity = Readonly<{
  dev: bigint
  ino: bigint
  mtimeNs: bigint
  size: bigint
}>

function sameFile(left: BigIdentity, right: BigIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  )
}

function parentPaths(filePath: string): string[] {
  const root = path.parse(filePath).root
  const result: string[] = []
  let current = path.dirname(filePath)
  while (current !== root) {
    result.push(current)
    current = path.dirname(current)
  }
  result.reverse()
  if (result.length > 63) {
    throw new Error('Subtitle parent chain exceeds its fixed depth')
  }
  return result
}

/**
 * Captures the native chooser's file and canonical-parent identities. The
 * engine rechecks all of them when it reads the one-use grant.
 */
export async function captureExternalSubtitleGrant(
  selectedPath: string
): Promise<ExternalSubtitleGrant> {
  if (!path.isAbsolute(selectedPath)) {
    throw new Error('Subtitle chooser returned a non-absolute path')
  }

  const selected = await lstat(selectedPath, { bigint: true })
  if (!selected.isFile() || selected.isSymbolicLink()) {
    throw new Error('Subtitle chooser selection is not a regular file')
  }
  const canonicalPath = await realpath(selectedPath)
  const handle = await open(
    selectedPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  )
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(selected, opened)) {
      throw new Error('Subtitle changed while its chooser grant was captured')
    }

    const parentChain: ExternalSubtitleGrant['parentChain'] = []
    for (const parentPath of parentPaths(canonicalPath)) {
      const parent = await lstat(parentPath, { bigint: true })
      if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new Error('Subtitle canonical parent chain is not stable')
      }
      parentChain.push({
        device: parent.dev.toString(),
        inode: parent.ino.toString(),
        path: parentPath
      })
    }

    const canonicalAgain = await realpath(selectedPath)
    const openedAgain = await handle.stat({ bigint: true })
    if (canonicalAgain !== canonicalPath || !sameFile(opened, openedAgain)) {
      throw new Error('Subtitle changed while its chooser grant was captured')
    }

    return {
      canonicalPath,
      file: {
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        modifiedNs: opened.mtimeNs.toString(),
        size: opened.size.toString()
      },
      parentChain
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}
