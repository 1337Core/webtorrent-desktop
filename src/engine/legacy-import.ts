import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import type { EgressPolicy } from './network-policy'
import {
  validateTorrentMetadata,
  type ValidatedTorrentMetadata
} from './torrent-metadata'

export const LEGACY_IMPORT_LIMITS = Object.freeze({
  maxConfigBytes: 8_000_000,
  maxTorrentBytes: 10_000_000,
  maxTorrents: 5_000,
  posterDirectory: 'Posters',
  stateFile: 'config.json',
  torrentDirectory: 'Torrents'
})

export type LegacyImportErrorCode =
  'ROOT_NOT_AUTHORIZED' | 'STATE_UNREADABLE' | 'TOO_MANY_TORRENTS'

export class LegacyImportError extends Error {
  readonly code: LegacyImportErrorCode

  constructor(code: LegacyImportErrorCode) {
    super(`Legacy import failed: ${code}.`)
    this.name = 'LegacyImportError'
    this.code = code
  }
}

type LegacySkipReason =
  | 'DUPLICATE'
  | 'INVALID_ENTRY'
  | 'INVALID_METADATA'
  | 'PRIVATE_WITHOUT_TRACKER'
  | 'TORRENT_FILE_MISSING'
  | 'UNSUPPORTED_FORMAT'

export type LegacyImportEntry =
  | Readonly<{
      infoHash: string
      kind: 'importable'
      metadata: ValidatedTorrentMetadata
      name: string
      selectedPaths: ReadonlyArray<string>
    }>
  | Readonly<{
      kind: 'skipped'
      name: string
      reason: LegacySkipReason
    }>

export type LegacyPreferences = Readonly<{
  autoAddTorrents: boolean
  downloadPath: string | null
  externalPlayerPath: string | null
  highestPlaybackPriority: boolean
  openExternalPlayer: boolean
  soundNotifications: boolean
  startup: boolean
  torrentsFolderPath: string | null
}>

export type LegacyImportReport = Readonly<{
  entries: ReadonlyArray<LegacyImportEntry>
  preferences: LegacyPreferences | null
  scannedTorrentCount: number
  version: string | null
}>

function optionalAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null
  if (!path.isAbsolute(value) || value.includes('\0')) return null
  return path.normalize(value)
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function entryName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value === '') return fallback
  return value.length > 255 ? `${value.slice(0, 252)}...` : value
}

/**
 * Reads a previous WebTorrent Desktop profile without ever modifying it.
 *
 * Nothing here writes, renames, or deletes inside the legacy directory, and
 * no historical side-effecting migration is executed. Every torrent is
 * re-validated through the ordinary raw metadata boundary, so a legacy entry
 * that is unsupported today is reported as skipped rather than silently
 * loaded, and no entry is trusted to be complete because the legacy JSON said
 * so.
 */
export class LegacyImporter {
  readonly #policy: EgressPolicy
  readonly #root: string
  readonly #validate: typeof validateTorrentMetadata

  constructor(
    options: Readonly<{
      policy: EgressPolicy
      root: string
      validate?: typeof validateTorrentMetadata
    }>
  ) {
    if (!path.isAbsolute(options.root)) {
      throw new LegacyImportError('ROOT_NOT_AUTHORIZED')
    }
    this.#policy = options.policy
    this.#root = path.resolve(options.root)
    this.#validate = options.validate ?? validateTorrentMetadata
  }

  async scan(): Promise<LegacyImportReport> {
    const state = await this.#readState()
    const rawTorrents = Array.isArray(state.torrents) ? state.torrents : []
    if (rawTorrents.length > LEGACY_IMPORT_LIMITS.maxTorrents) {
      throw new LegacyImportError('TOO_MANY_TORRENTS')
    }

    const entries: LegacyImportEntry[] = []
    const seen = new Set<string>()
    for (const [index, raw] of rawTorrents.entries()) {
      entries.push(await this.#readEntry(raw, index, seen))
    }

    return {
      entries,
      preferences: this.#readPreferences(state.prefs),
      scannedTorrentCount: rawTorrents.length,
      version: typeof state.version === 'string' ? state.version : null
    }
  }

  async #readState(): Promise<Record<string, unknown>> {
    const target = path.join(this.#root, LEGACY_IMPORT_LIMITS.stateFile)
    let raw: string
    try {
      raw = await this.#readTextNoFollow(
        target,
        LEGACY_IMPORT_LIMITS.maxConfigBytes
      )
    } catch {
      throw new LegacyImportError('STATE_UNREADABLE')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new LegacyImportError('STATE_UNREADABLE')
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new LegacyImportError('STATE_UNREADABLE')
    }
    return parsed as Record<string, unknown>
  }

  #readPreferences(value: unknown): LegacyPreferences | null {
    if (typeof value !== 'object' || value === null) return null
    const prefs = value as Record<string, unknown>
    return {
      autoAddTorrents: booleanOr(prefs.autoAddTorrents, false),
      downloadPath: optionalAbsolutePath(prefs.downloadPath),
      externalPlayerPath: optionalAbsolutePath(prefs.externalPlayerPath),
      highestPlaybackPriority: booleanOr(prefs.highestPlaybackPriority, true),
      openExternalPlayer: booleanOr(prefs.openExternalPlayer, false),
      soundNotifications: booleanOr(prefs.soundNotifications, true),
      startup: booleanOr(prefs.startup, false),
      torrentsFolderPath: optionalAbsolutePath(prefs.torrentsFolderPath)
    }
  }

  async #readEntry(
    raw: unknown,
    index: number,
    seen: Set<string>
  ): Promise<LegacyImportEntry> {
    const fallbackName = `Legacy torrent ${index + 1}`
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'skipped', name: fallbackName, reason: 'INVALID_ENTRY' }
    }

    const entry = raw as Record<string, unknown>
    const name = entryName(entry.displayName ?? entry.name, fallbackName)
    const fileName = entry.torrentFileName
    if (
      typeof fileName !== 'string' ||
      fileName === '' ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('\0') ||
      path.basename(fileName) !== fileName
    ) {
      return { kind: 'skipped', name, reason: 'INVALID_ENTRY' }
    }

    let bytes: Uint8Array
    try {
      bytes = await this.#readBytesNoFollow(
        path.join(this.#root, LEGACY_IMPORT_LIMITS.torrentDirectory, fileName),
        LEGACY_IMPORT_LIMITS.maxTorrentBytes
      )
    } catch {
      return { kind: 'skipped', name, reason: 'TORRENT_FILE_MISSING' }
    }

    let metadata: ValidatedTorrentMetadata
    try {
      metadata = await this.#validate(bytes, this.#policy)
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
      if (code === 'PRIVATE_TRACKER_REQUIRED') {
        return { kind: 'skipped', name, reason: 'PRIVATE_WITHOUT_TRACKER' }
      }
      if (code === 'UNSUPPORTED_V2') {
        return { kind: 'skipped', name, reason: 'UNSUPPORTED_FORMAT' }
      }
      return { kind: 'skipped', name, reason: 'INVALID_METADATA' }
    }

    if (seen.has(metadata.infoHash)) {
      return { kind: 'skipped', name, reason: 'DUPLICATE' }
    }
    seen.add(metadata.infoHash)

    return {
      infoHash: metadata.infoHash,
      kind: 'importable',
      metadata,
      name,
      selectedPaths: this.#selectedPaths(entry.selections, metadata)
    }
  }

  /**
   * Legacy selections are index-keyed; the new model is keyed by normalized
   * path. A malformed or mismatched selection selects everything rather than
   * silently dropping files.
   */
  #selectedPaths(
    selections: unknown,
    metadata: ValidatedTorrentMetadata
  ): ReadonlyArray<string> {
    if (
      !Array.isArray(selections) ||
      selections.length !== metadata.files.length
    ) {
      return metadata.files.map(file => file.path)
    }
    const selected = metadata.files
      .filter((_file, index) => selections[index] === true)
      .map(file => file.path)
    return selected.length > 0
      ? selected
      : metadata.files.map(file => file.path)
  }

  async #readTextNoFollow(target: string, maximum: number): Promise<string> {
    const bytes = await this.#readBytesNoFollow(target, maximum)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }

  /** No-follow reads: a legacy path replaced by a symlink is not followed. */
  async #readBytesNoFollow(
    target: string,
    maximum: number
  ): Promise<Uint8Array> {
    const stats = await lstat(target)
    if (!stats.isFile() || stats.size > maximum) {
      throw new LegacyImportError('STATE_UNREADABLE')
    }
    const handle = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    )
    try {
      const contents = await handle.readFile()
      if (contents.byteLength > maximum) {
        throw new LegacyImportError('STATE_UNREADABLE')
      }
      return new Uint8Array(contents)
    } finally {
      await handle.close()
    }
  }
}
