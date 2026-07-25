import type { EngineCommandResult } from '../shared/engine-api'
import {
  LegacyImporter,
  type LegacyImportEntry,
  type LegacyImportReport
} from './legacy-import'
import type { EgressPolicy } from './network-policy'
import type { ValidatedTorrentMetadata } from './torrent-metadata'

type EngineSuccess = Extract<EngineCommandResult, { ok: true }>['result']

export type LegacyImportPage = Extract<
  EngineSuccess,
  { command: 'list-legacy-imports' }
>['value']

export type LegacyImportCandidate = Readonly<{
  metadata: ValidatedTorrentMetadata
  selectedIndexes: ReadonlyArray<number>
}>

const MAX_PAGE_SIZE = 64
const MAX_PAGE_NAME_BYTES = 16_384
const CACHE_TTL_MS = 15 * 60_000
const utf8Encoder = new TextEncoder()

type CachedScan = {
  report: LegacyImportReport
  scannedAtMs: number
}

/**
 * Serves the legacy profile to the renderer as bounded pages and imports one
 * scanned entry at a time.
 *
 * The scan itself never mutates the legacy profile; this only caches its
 * result so paging and importing do not reread and revalidate the whole
 * profile per command.
 */
export class LegacyImportService {
  readonly #cache = new Map<string, CachedScan>()
  readonly #createImporter: (root: string) => LegacyImporter
  readonly #now: () => number

  constructor(
    options: Readonly<{
      createImporter?: (root: string) => LegacyImporter
      now?: () => number
      policy: EgressPolicy
    }>
  ) {
    this.#createImporter =
      options.createImporter ??
      (root => new LegacyImporter({ policy: options.policy, root }))
    this.#now = options.now ?? (() => Date.now())
  }

  async page(
    legacyRoot: string,
    cursor: number,
    limit: number
  ): Promise<LegacyImportPage> {
    const report = await this.#scan(legacyRoot)
    const entries = report.entries
    const size = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)

    const items: LegacyImportPage['items'][number][] = []
    let nameBytes = 0
    let index = Math.max(cursor, 0)
    for (; index < entries.length && items.length < size; index += 1) {
      const entry = entries[index]
      if (!entry) break
      nameBytes += utf8Encoder.encode(entry.name).byteLength
      if (nameBytes > MAX_PAGE_NAME_BYTES && items.length > 0) break
      items.push(summarize(entry))
    }

    return {
      items,
      nextCursor: index < entries.length ? index : null,
      skippedCount: entries.filter(entry => entry.kind === 'skipped').length,
      total: entries.length
    }
  }

  /**
   * Returns an importable entry once. Consuming it keeps a repeated command
   * from adding the same torrent twice while the scan is still cached.
   */
  async take(
    legacyRoot: string,
    infoHash: string
  ): Promise<LegacyImportCandidate | null> {
    const report = await this.#scan(legacyRoot)
    const entry = report.entries.find(
      candidate =>
        candidate.kind === 'importable' && candidate.infoHash === infoHash
    )
    if (!entry || entry.kind !== 'importable') return null

    const selected = new Set(entry.selectedPaths)
    const candidate: LegacyImportCandidate = {
      metadata: entry.metadata,
      selectedIndexes: entry.metadata.files
        .filter(file => selected.has(file.path))
        .map(file => file.index)
    }

    this.#cache.set(legacyRoot, {
      report: {
        ...report,
        entries: report.entries.map(existing =>
          existing === entry
            ? { kind: 'skipped', name: entry.name, reason: 'DUPLICATE' }
            : existing
        )
      },
      scannedAtMs: this.#now()
    })
    return candidate
  }

  forget(legacyRoot: string): void {
    this.#cache.delete(legacyRoot)
  }

  async #scan(legacyRoot: string): Promise<LegacyImportReport> {
    const cached = this.#cache.get(legacyRoot)
    if (cached && this.#now() - cached.scannedAtMs < CACHE_TTL_MS) {
      return cached.report
    }

    const report = await this.#createImporter(legacyRoot).scan()
    this.#cache.set(legacyRoot, { report, scannedAtMs: this.#now() })
    return report
  }
}

function summarize(
  entry: LegacyImportEntry
): LegacyImportPage['items'][number] {
  if (entry.kind === 'skipped') {
    return { kind: 'skipped', name: entry.name, reason: entry.reason }
  }
  const selected = new Set(entry.selectedPaths)
  return {
    fileCount: entry.metadata.files.length,
    infoHash: entry.infoHash,
    kind: 'importable',
    length: entry.metadata.length,
    name: entry.name,
    private: entry.metadata.private,
    selectedFileCount: entry.metadata.files.filter(file =>
      selected.has(file.path)
    ).length
  }
}
