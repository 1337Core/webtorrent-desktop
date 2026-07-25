import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { Diagnostics } from './diagnostics'

export const TORRENT_HANDLER_LIMITS = Object.freeze({
  maxMagnetLength: 65_536,
  maxTorrentBytes: 10_000_000,
  protocol: 'magnet'
})

export type TorrentHandlerIntent =
  | Readonly<{ kind: 'magnet'; magnet: string }>
  | Readonly<{ kind: 'torrent-file'; torrentPath: string }>

export type TorrentHandlersOptions = Readonly<{
  diagnostics: Diagnostics
  electronApp?: Pick<
    typeof app,
    | 'isDefaultProtocolClient'
    | 'removeAsDefaultProtocolClient'
    | 'setAsDefaultProtocolClient'
  >
  onIntent: (intent: TorrentHandlerIntent) => void
}>

/**
 * Turns macOS open events and launch arguments into validated intents.
 *
 * An intent is a request, not an add: the engine still validates whatever it
 * receives. OS defaults are never taken over silently — registration happens
 * only when the owner explicitly asks for it.
 */
export class TorrentHandlers {
  readonly #diagnostics: Diagnostics
  readonly #electronApp: NonNullable<TorrentHandlersOptions['electronApp']>
  readonly #onIntent: (intent: TorrentHandlerIntent) => void

  constructor(options: TorrentHandlersOptions) {
    this.#diagnostics = options.diagnostics
    this.#electronApp = options.electronApp ?? app
    this.#onIntent = options.onIntent
  }

  /** Handles a `magnet:` URL from the OS or a second launch. */
  handleUrl(value: unknown): boolean {
    if (
      typeof value !== 'string' ||
      value.length > TORRENT_HANDLER_LIMITS.maxMagnetLength ||
      value.includes('\0')
    ) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return false
    }
    if (parsed.protocol !== 'magnet:') return false

    this.#emit({ kind: 'magnet', magnet: value })
    return true
  }

  /** Handles a `.torrent` file opened from Finder or an argument. */
  async handleFile(value: unknown): Promise<boolean> {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.includes('\0') ||
      path.normalize(value) !== value ||
      path.extname(value).toLowerCase() !== '.torrent'
    ) {
      return false
    }

    let entry
    try {
      entry = await lstat(value)
    } catch {
      return false
    }
    // Not followed: a symlinked argument is refused rather than resolved.
    if (
      !entry.isFile() ||
      entry.size > TORRENT_HANDLER_LIMITS.maxTorrentBytes
    ) {
      return false
    }

    this.#emit({ kind: 'torrent-file', torrentPath: value })
    return true
  }

  /**
   * Handles a launch or second-instance argument vector. Only recognized
   * magnet URLs and `.torrent` paths are considered; every other argument,
   * including switches, is ignored.
   */
  async handleArguments(argv: ReadonlyArray<string>): Promise<number> {
    let handled = 0
    for (const argument of argv.slice(1)) {
      if (typeof argument !== 'string' || argument.startsWith('-')) continue
      if (argument.startsWith('magnet:')) {
        if (this.handleUrl(argument)) handled += 1
        continue
      }
      if (await this.handleFile(argument)) handled += 1
    }
    return handled
  }

  isDefaultHandler(): boolean {
    try {
      return this.#electronApp.isDefaultProtocolClient(
        TORRENT_HANDLER_LIMITS.protocol
      )
    } catch {
      return false
    }
  }

  /** Only ever called from an explicit owner action. */
  setDefaultHandler(enabled: boolean): boolean {
    try {
      return enabled
        ? this.#electronApp.setAsDefaultProtocolClient(
            TORRENT_HANDLER_LIMITS.protocol
          )
        : this.#electronApp.removeAsDefaultProtocolClient(
            TORRENT_HANDLER_LIMITS.protocol
          )
    } catch {
      this.#diagnostics.warn('handlers.registration-failed')
      return false
    }
  }

  #emit(intent: TorrentHandlerIntent): void {
    try {
      this.#onIntent(intent)
    } catch {
      this.#diagnostics.warn('handlers.intent-failed')
    }
  }
}
