import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Diagnostics } from './diagnostics'

export type ExternalPlayerErrorCode =
  'LAUNCH_FAILED' | 'PLAYER_NOT_AUTHORIZED' | 'URL_NOT_AUTHORIZED'

export class ExternalPlayerError extends Error {
  readonly code: ExternalPlayerErrorCode

  constructor(code: ExternalPlayerErrorCode) {
    super(`External player launch failed: ${code}.`)
    this.name = 'ExternalPlayerError'
    this.code = code
  }
}

export type ExternalPlayerLaunch = (
  file: string,
  args: ReadonlyArray<string>
) => void

export type ExternalPlayerOptions = Readonly<{
  diagnostics: Diagnostics
  /** The engine's live media port; a URL for any other port is refused. */
  getMediaPort: () => number | null
  launch?: ExternalPlayerLaunch
}>

const MEDIA_PATH_PATTERN = /^\/v1\/media\/[A-Za-z0-9_-]{43}$/u

function defaultLaunch(file: string, args: ReadonlyArray<string>): void {
  // execFile, never a shell string: a player path or URL is never parsed by a
  // shell, so quoting and metacharacters cannot become arguments.
  const child = execFile(file, [...args], { shell: false }, () => undefined)
  child.unref()
}

/**
 * Opens one already authorized media URL in a user-selected player.
 *
 * The player must be an absolute path to a real executable file the user
 * picked, and the URL must be exactly one of the engine's loopback media
 * routes on its current port. Nothing else is ever launched.
 */
export class ExternalPlayer {
  readonly #diagnostics: Diagnostics
  readonly #getMediaPort: () => number | null
  readonly #launch: ExternalPlayerLaunch

  constructor(options: ExternalPlayerOptions) {
    this.#diagnostics = options.diagnostics
    this.#getMediaPort = options.getMediaPort
    this.#launch = options.launch ?? defaultLaunch
  }

  async open(
    request: Readonly<{ mediaUrl: string; playerPath: string }>
  ): Promise<void> {
    const player = await this.#authorizedPlayer(request.playerPath)
    const url = this.#authorizedUrl(request.mediaUrl)

    try {
      this.#launch(player, [url])
    } catch {
      this.#diagnostics.warn('external-player.launch-failed')
      throw new ExternalPlayerError('LAUNCH_FAILED')
    }
    this.#diagnostics.info('external-player.launched')
  }

  async #authorizedPlayer(playerPath: string): Promise<string> {
    if (
      typeof playerPath !== 'string' ||
      !path.isAbsolute(playerPath) ||
      playerPath.includes('\0') ||
      path.normalize(playerPath) !== playerPath
    ) {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }

    // The macOS open panel returns an application bundle, which is a
    // directory. Its declared executable is resolved here so an ordinary Mac
    // player can be chosen at all; every check below then applies to that
    // executable rather than to the bundle.
    const resolvedPath = playerPath.endsWith('.app')
      ? await this.#bundleExecutable(playerPath)
      : playerPath

    let entry
    try {
      entry = await lstat(resolvedPath)
    } catch {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }
    // A symlinked or non-regular player target is refused rather than resolved.
    if (!entry.isFile()) {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }
    return this.#executable(resolvedPath)
  }

  /**
   * The executable inside a macOS application bundle.
   *
   * `CFBundleExecutable` is read from the bundle's own `Info.plist` and must
   * be a plain file name: a separator, traversal segment, or null byte would
   * leave `Contents/MacOS`, so it is refused rather than resolved. When the
   * key is absent the bundle's own name is the documented default.
   */
  async #bundleExecutable(bundlePath: string): Promise<string> {
    let bundle
    try {
      bundle = await lstat(bundlePath)
    } catch {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }
    if (!bundle.isDirectory()) {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }

    let declaredName: string | null
    try {
      const plist = await readFile(
        path.join(bundlePath, 'Contents', 'Info.plist'),
        'utf8'
      )
      declaredName =
        /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/u.exec(
          plist
        )?.[1] ?? null
    } catch {
      declaredName = null
    }

    const executableName = declaredName ?? path.basename(bundlePath, '.app')
    if (
      executableName === '' ||
      executableName.includes('/') ||
      executableName.includes('\0') ||
      executableName === '.' ||
      executableName === '..'
    ) {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }

    return path.join(bundlePath, 'Contents', 'MacOS', executableName)
  }

  async #executable(playerPath: string): Promise<string> {
    try {
      await access(playerPath, fsConstants.X_OK)
    } catch {
      throw new ExternalPlayerError('PLAYER_NOT_AUTHORIZED')
    }
    return playerPath
  }

  #authorizedUrl(mediaUrl: string): string {
    const port = this.#getMediaPort()
    if (port === null) throw new ExternalPlayerError('URL_NOT_AUTHORIZED')

    let parsed: URL
    try {
      parsed = new URL(mediaUrl)
    } catch {
      throw new ExternalPlayerError('URL_NOT_AUTHORIZED')
    }
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.port !== String(port) ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !MEDIA_PATH_PATTERN.test(parsed.pathname)
    ) {
      throw new ExternalPlayerError('URL_NOT_AUTHORIZED')
    }
    return parsed.href
  }
}
