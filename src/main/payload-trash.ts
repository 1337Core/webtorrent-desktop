import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type { Diagnostics } from './diagnostics'

export type PayloadTrashErrorCode =
  'NOT_AUTHORIZED' | 'NOT_FOUND' | 'TRASH_FAILED' | 'UNSAFE_TARGET'

export class PayloadTrashError extends Error {
  readonly code: PayloadTrashErrorCode

  constructor(code: PayloadTrashErrorCode) {
    super(`Payload deletion failed: ${code}.`)
    this.name = 'PayloadTrashError'
    this.code = code
  }
}

export type PayloadTrashRequest = Readonly<{
  /** Every manifest path, relative to the download root. */
  files: ReadonlyArray<string>
  /** The user-selected download root; never itself a deletion target. */
  root: string
  /** The torrent-owned directory under the root, when the torrent has one. */
  torrentDirectory: string | null
}>

export type PayloadTrashReport = Readonly<{
  missing: ReadonlyArray<string>
  trashed: ReadonlyArray<string>
}>

export type PayloadTrashOptions = Readonly<{
  diagnostics: Diagnostics
  trashItem?: (target: string) => Promise<void>
}>

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  )
}

/**
 * Moves a torrent's payload to the macOS Trash.
 *
 * Removing a torrent and deleting its payload are separate explicit actions,
 * so nothing here runs unless the user asked for deletion. No symlink is ever
 * followed or trashed as a directory, nothing outside the authorized root is
 * touched, and the containing download root is never deleted — only a
 * torrent-owned directory that is exactly the torrent's own and holds nothing
 * else.
 */
export class PayloadTrash {
  readonly #diagnostics: Diagnostics
  readonly #trashItem: (target: string) => Promise<void>

  constructor(options: PayloadTrashOptions) {
    this.#diagnostics = options.diagnostics
    this.#trashItem = options.trashItem ?? (target => shell.trashItem(target))
  }

  async delete(request: PayloadTrashRequest): Promise<PayloadTrashReport> {
    const root = this.#authorizedRoot(request.root)
    const targets = this.#targets(root, request)

    const missing: string[] = []
    const trashed: string[] = []
    for (const target of targets) {
      let entry
      try {
        entry = await lstat(target)
      } catch {
        missing.push(target)
        continue
      }
      // A symlink is removed as a link, never followed to its destination.
      if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new PayloadTrashError('UNSAFE_TARGET')
      }
      try {
        await this.#trashItem(target)
        trashed.push(target)
      } catch {
        this.#diagnostics.warn('payload.trash-failed')
        throw new PayloadTrashError('TRASH_FAILED')
      }
    }

    if (request.torrentDirectory !== null) {
      await this.#trashOwnedDirectory(root, request.torrentDirectory, trashed)
    }

    this.#diagnostics.info('payload.trashed', {
      missing: missing.length,
      trashed: trashed.length
    })
    return { missing, trashed }
  }

  #authorizedRoot(value: string): string {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.includes('\0') ||
      path.normalize(value) !== value
    ) {
      throw new PayloadTrashError('NOT_AUTHORIZED')
    }
    return path.resolve(value)
  }

  #targets(root: string, request: PayloadTrashRequest): ReadonlyArray<string> {
    const targets: string[] = []
    for (const file of request.files) {
      if (
        typeof file !== 'string' ||
        file === '' ||
        path.isAbsolute(file) ||
        file.includes('\0') ||
        file.split('/').some(segment => segment === '..' || segment === '.')
      ) {
        throw new PayloadTrashError('UNSAFE_TARGET')
      }
      const target = path.resolve(root, file)
      if (!isContained(root, target)) {
        throw new PayloadTrashError('UNSAFE_TARGET')
      }
      targets.push(target)
    }
    return targets
  }

  /**
   * Only an emptied, torrent-owned directory directly under the root is
   * removed. The download root itself is never a target.
   */
  async #trashOwnedDirectory(
    root: string,
    torrentDirectory: string,
    trashed: string[]
  ): Promise<void> {
    const target = path.resolve(root, torrentDirectory)
    if (
      !isContained(root, target) ||
      path.dirname(target) !== root ||
      target === root
    ) {
      throw new PayloadTrashError('UNSAFE_TARGET')
    }

    let entry
    try {
      entry = await lstat(target)
    } catch {
      return
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return

    const remaining = await readdir(target)
    if (remaining.length > 0) return

    try {
      await this.#trashItem(target)
      trashed.push(target)
    } catch {
      this.#diagnostics.warn('payload.trash-directory-failed')
    }
  }
}
