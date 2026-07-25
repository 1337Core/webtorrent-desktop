import path from 'node:path'
import type {
  EngineCommand,
  EngineCommandResult,
  TorrentRecord
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { PayloadTrash } from './payload-trash'
import type { AppStateStore } from './state-store'
import type { TorrentLibrary } from './torrent-library'

/** The manifest is paged; a torrent cannot hold more files than this. */
const MAX_MANIFEST_FILES = 100_000
const PAGE_LIMIT = 64

export type MenuTemplateItem = Readonly<{
  click?: () => void
  enabled?: boolean
  label?: string
  type?: 'separator'
}>

type PoppedMenu = Readonly<{
  popup: () => void
}>

export type TorrentContextMenuOptions = Readonly<{
  /** Wraps `Menu.buildFromTemplate`, so the menu itself stays main-owned. */
  buildMenu: (template: ReadonlyArray<MenuTemplateItem>) => PoppedMenu
  copyText: (text: string) => void
  diagnostics: Diagnostics
  execute: (operation: EngineCommand) => Promise<EngineCommandResult>
  library: TorrentLibrary
  payloadTrash: PayloadTrash
  revealPath: (target: string) => void
  stateStore: AppStateStore
}>

/**
 * The original torrent row's right-click menu. Main builds it, main runs every
 * action, and the renderer only names the torrent: no path, no menu template,
 * and no deletion authority ever crosses the boundary.
 *
 * The original also offered an instant.io link and "Save Torrent File As…".
 * The first sent the owner to a third-party service and is gone with the other
 * removals in section 4.2; the second is not ported yet.
 */
export class TorrentContextMenu {
  readonly #options: TorrentContextMenuOptions

  constructor(options: TorrentContextMenuOptions) {
    this.#options = options
  }

  /** Returns false when the torrent is not in the library to act on. */
  open(infoHash: string): boolean {
    const record = this.#options.stateStore
      .listTorrents()
      .find(entry => entry.infoHash === infoHash)
    if (!record) return false

    const menu = this.#options.buildMenu([
      {
        label: 'Remove From List',
        click: () => void this.#remove(record, false)
      },
      {
        label: 'Remove Data File',
        click: () => void this.#remove(record, true)
      },
      { type: 'separator' },
      {
        label: 'Show in Finder',
        click: () => {
          this.#options.revealPath(
            path.join(record.destinationRoot, record.name)
          )
        }
      },
      { type: 'separator' },
      {
        label: 'Copy Magnet Link to Clipboard',
        click: () => {
          this.#options.copyText(
            `magnet:?xt=urn:btih:${record.infoHash}&dn=${encodeURIComponent(record.name)}`
          )
        }
      }
    ])
    menu.popup()
    return true
  }

  /**
   * Removal and deletion are one user action here, but two ordered steps: the
   * manifest is read while the torrent still exists, the torrent is released,
   * and only then is its payload trashed.
   */
  async #remove(record: TorrentRecord, deleteData: boolean): Promise<void> {
    const files = deleteData ? await this.#manifest(record.infoHash) : []

    const operation: EngineCommand = {
      command: 'remove-torrent',
      payload: { deleteData: false, infoHash: record.infoHash }
    }
    const result = await this.#options.execute(operation)
    this.#options.library.record(operation, result)
    if (!result.ok) {
      this.#options.diagnostics.warn('context-menu.remove-failed', {
        code: result.error.code
      })
      return
    }
    if (!deleteData || files.length === 0) return

    try {
      await this.#options.payloadTrash.delete({
        files,
        root: record.destinationRoot,
        // A multi-file torrent owns the directory named after it; a
        // single-file torrent owns no directory of its own.
        torrentDirectory: files.some(file => file.includes('/'))
          ? record.name
          : null
      })
    } catch (error) {
      this.#options.diagnostics.warn('context-menu.trash-failed', {
        reason: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  /** Every manifest path, walked page by page while the torrent still lives. */
  async #manifest(infoHash: string): Promise<ReadonlyArray<string>> {
    const files: string[] = []
    let cursor: number | null = 0

    while (cursor !== null && files.length < MAX_MANIFEST_FILES) {
      const result: EngineCommandResult = await this.#options.execute({
        command: 'get-torrent-files',
        payload: { cursor, infoHash, limit: PAGE_LIMIT }
      })
      if (!result.ok || result.result.command !== 'get-torrent-files') break
      for (const file of result.result.value.items) files.push(file.path)
      cursor = result.result.value.nextCursor
    }

    return files
  }
}
