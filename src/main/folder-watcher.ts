import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { Diagnostics } from './diagnostics'

export const FOLDER_WATCH_LIMITS = Object.freeze({
  maxTorrentBytes: 10_000_000,
  settleMs: 2_000
})

export type FolderWatcherErrorCode = 'PATH_NOT_AUTHORIZED'

export class FolderWatcherError extends Error {
  readonly code: FolderWatcherErrorCode

  constructor(code: FolderWatcherErrorCode) {
    super(`Folder watch failed: ${code}.`)
    this.name = 'FolderWatcherError'
    this.code = code
  }
}

export type FolderWatcherOptions = Readonly<{
  createWatcher?: (folder: string) => FSWatcher
  diagnostics: Diagnostics
  onTorrent: (torrentPath: string) => void
}>

/**
 * Watches one user-selected folder for `.torrent` files.
 *
 * The feature is explicit and off by default. Only a real, regular,
 * reasonably sized `.torrent` directly inside the chosen folder is reported:
 * no recursion, no symlink following, and no other file type. Reporting a
 * path is not adding a torrent — the engine still validates it.
 */
export class FolderWatcher {
  readonly #createWatcher: (folder: string) => FSWatcher
  readonly #diagnostics: Diagnostics
  readonly #onTorrent: (torrentPath: string) => void
  #folder: string | null = null
  #watcher: FSWatcher | null = null

  constructor(options: FolderWatcherOptions) {
    this.#createWatcher =
      options.createWatcher ??
      (folder =>
        watch(folder, {
          awaitWriteFinish: {
            pollInterval: 100,
            stabilityThreshold: FOLDER_WATCH_LIMITS.settleMs
          },
          depth: 0,
          followSymlinks: false,
          // Only files that arrive after the watcher starts are reported.
          // Otherwise every launch reopens an add for each existing file.
          ignoreInitial: true,
          persistent: true
        }))
    this.#diagnostics = options.diagnostics
    this.#onTorrent = options.onTorrent
  }

  get folder(): string | null {
    return this.#folder
  }

  async watch(folder: string): Promise<void> {
    const target = this.#authorizedFolder(folder)
    await this.stop()

    const watcher = this.#createWatcher(target)
    this.#watcher = watcher
    this.#folder = target

    watcher.on('add', (candidate: string) => {
      void this.#report(candidate)
    })
    watcher.on('error', () => {
      this.#diagnostics.warn('folder-watch.failed')
    })
    this.#diagnostics.info('folder-watch.started')
  }

  async stop(): Promise<void> {
    const watcher = this.#watcher
    this.#watcher = null
    this.#folder = null
    if (!watcher) return
    try {
      await watcher.close()
    } catch {
      // A watcher that refuses to close is already unusable.
    }
  }

  #authorizedFolder(folder: string): string {
    if (
      typeof folder !== 'string' ||
      !path.isAbsolute(folder) ||
      folder.includes('\0') ||
      path.normalize(folder) !== folder
    ) {
      throw new FolderWatcherError('PATH_NOT_AUTHORIZED')
    }
    return path.resolve(folder)
  }

  async #report(candidate: string): Promise<void> {
    const folder = this.#folder
    if (folder === null) return

    const resolved = path.resolve(candidate)
    if (
      path.dirname(resolved) !== folder ||
      path.extname(resolved).toLowerCase() !== '.torrent'
    ) {
      return
    }

    let entry
    try {
      entry = await lstat(resolved)
    } catch {
      return
    }
    if (!entry.isFile() || entry.size > FOLDER_WATCH_LIMITS.maxTorrentBytes) {
      return
    }

    try {
      this.#onTorrent(resolved)
    } catch {
      this.#diagnostics.warn('folder-watch.handler-failed')
    }
  }
}
