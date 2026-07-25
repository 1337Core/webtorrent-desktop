import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Bounds on the walk. A creation source is user-chosen, but a deep or
 * pathological tree must not stall the dialog, so the walk stops once either
 * bound is reached and reports what it measured up to that point.
 */
const SOURCE_SUMMARY_LIMITS = {
  maxDepth: 16,
  maxEntries: 20_000
} as const

export type SourceSummary = {
  fileCount: number
  totalBytes: number
}

/**
 * Counts the files a torrent created from this path would contain, matching
 * what creation itself does: dotfiles are excluded, and symlinks are never
 * followed. Main measures it so the renderer can show the original
 * "N files, SIZE" line without ever reading the filesystem.
 */
export async function measureSource(
  sourcePath: string
): Promise<SourceSummary | null> {
  let root
  try {
    root = await lstat(sourcePath)
  } catch {
    return null
  }
  if (root.isSymbolicLink()) return null
  if (root.isFile()) return { fileCount: 1, totalBytes: root.size }
  if (!root.isDirectory()) return null

  const summary: SourceSummary = { fileCount: 0, totalBytes: 0 }
  let visited = 0
  const pending: Array<{ depth: number; directory: string }> = [
    { depth: 0, directory: sourcePath }
  ]

  while (pending.length > 0) {
    const next = pending.pop()
    if (!next) break
    if (next.depth > SOURCE_SUMMARY_LIMITS.maxDepth) continue

    let entries
    try {
      entries = await readdir(next.directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (visited >= SOURCE_SUMMARY_LIMITS.maxEntries) return summary
      visited += 1
      if (entry.name.startsWith('.')) continue
      const child = path.join(next.directory, entry.name)
      if (entry.isDirectory()) {
        pending.push({ depth: next.depth + 1, directory: child })
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stats = await lstat(child)
        if (stats.isSymbolicLink()) continue
        summary.fileCount += 1
        summary.totalBytes += stats.size
      } catch {
        continue
      }
    }
  }

  return summary
}
