import path from 'node:path'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync
} from 'node:fs'
import { ipcMain } from 'electron'
import ElectronStore from 'electron-store'
import {
  appStateSchema,
  DEFAULT_APP_STATE,
  type AppState,
  type TorrentRecord
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'

const MAX_STATE_BYTES = 256 * 1024
const MAX_LIBRARY_TORRENTS = 64
const ELECTRON_STORE_RENDERER_CHANNEL = 'electron-store-get-data'

function cloneState(state: AppState): AppState {
  return structuredClone(state)
}

function ensureOwnedDirectory(directoryPath: string): void {
  if (existsSync(directoryPath)) {
    const metadata = lstatSync(directoryPath)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Application state path must be a real directory')
    }
  }
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
  chmodSync(directoryPath, 0o700)
}

function quarantineInvalidState(
  statePath: string,
  diagnostics: Diagnostics,
  reason: string
): void {
  const suffix = new Date().toISOString().replaceAll(/[:.]/gu, '-')
  const backupPath = `${statePath}.invalid-${suffix}`
  renameSync(statePath, backupPath)
  diagnostics.warn('state.quarantined', { reason })
}

function readExistingState(
  statePath: string,
  diagnostics: Diagnostics
): AppState | null {
  if (!existsSync(statePath)) return null
  const metadata = lstatSync(statePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Application state path must be a regular file')
  }

  if (statSync(statePath).size > MAX_STATE_BYTES) {
    quarantineInvalidState(statePath, diagnostics, 'SIZE_LIMIT')
    return null
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    quarantineInvalidState(statePath, diagnostics, 'MALFORMED_JSON')
    return null
  }

  if (
    parsedJson &&
    typeof parsedJson === 'object' &&
    'schemaVersion' in parsedJson &&
    typeof parsedJson.schemaVersion === 'number' &&
    parsedJson.schemaVersion > DEFAULT_APP_STATE.schemaVersion
  ) {
    throw new Error('Application state was written by a newer schema version')
  }

  const parsedState = appStateSchema.safeParse(parsedJson)
  if (!parsedState.success) {
    quarantineInvalidState(statePath, diagnostics, 'SCHEMA_INVALID')
    return null
  }

  return parsedState.data
}

export class AppStateStore {
  readonly #store: ElectronStore<AppState>
  #state: AppState

  constructor(userDataPath: string, diagnostics: Diagnostics) {
    ensureOwnedDirectory(userDataPath)
    const stateDirectory = path.join(userDataPath, 'state')
    ensureOwnedDirectory(stateDirectory)
    const statePath = path.join(stateDirectory, 'app-state.json')
    const existingState = readExistingState(statePath, diagnostics)
    if (existingState && existsSync(statePath)) chmodSync(statePath, 0o600)

    this.#store = new ElectronStore<AppState>({
      name: 'app-state',
      cwd: stateDirectory,
      accessPropertiesByDotNotation: false,
      clearInvalidConfig: false,
      configFileMode: 0o600,
      defaults: cloneState(DEFAULT_APP_STATE),
      watch: false
    })

    // electron-store installs this renderer compatibility channel even when
    // instantiated in main. This fork deliberately supports main-only access.
    const rendererListenerCount = ipcMain.listenerCount(
      ELECTRON_STORE_RENDERER_CHANNEL
    )
    if (rendererListenerCount > 1) {
      throw new Error(
        'electron-store installed unexpected renderer compatibility IPC'
      )
    }
    ipcMain.removeAllListeners(ELECTRON_STORE_RENDERER_CHANNEL)

    this.#state = existingState ?? cloneState(DEFAULT_APP_STATE)
    this.#persist(this.#state)
    diagnostics.info('state.ready', {
      revision: this.#state.revision,
      schemaVersion: this.#state.schemaVersion,
      source: existingState ? 'disk' : 'defaults'
    })
  }

  snapshot(): AppState {
    return cloneState(this.#state)
  }

  setWindowBounds(bounds: Electron.Rectangle): void {
    const previous = this.#state.window.main.normalBounds
    if (
      previous &&
      previous.x === bounds.x &&
      previous.y === bounds.y &&
      previous.width === bounds.width &&
      previous.height === bounds.height
    ) {
      return
    }

    this.#persist({
      ...this.#state,
      revision: this.#state.revision + 1,
      window: {
        main: {
          normalBounds: bounds
        }
      }
    })
  }

  /**
   * Records a torrent in the durable library. Selection, resume state, and
   * torrent bytes stay in fork-owned files so this document stays bounded.
   */
  upsertTorrent(record: TorrentRecord): AppState {
    const torrents = this.#state.library.torrents.filter(
      existing => existing.infoHash !== record.infoHash
    )
    if (torrents.length >= MAX_LIBRARY_TORRENTS) {
      throw new Error('The torrent library is full')
    }
    torrents.push(record)
    torrents.sort((left, right) => left.infoHash.localeCompare(right.infoHash))

    this.#persist({
      ...this.#state,
      library: { torrents },
      revision: this.#state.revision + 1
    })
    return this.snapshot()
  }

  removeTorrent(infoHash: string): boolean {
    const torrents = this.#state.library.torrents.filter(
      existing => existing.infoHash !== infoHash
    )
    if (torrents.length === this.#state.library.torrents.length) return false

    this.#persist({
      ...this.#state,
      library: { torrents },
      revision: this.#state.revision + 1
    })
    return true
  }

  listTorrents(): ReadonlyArray<TorrentRecord> {
    return this.#state.library.torrents.map(record => ({ ...record }))
  }

  #persist(candidate: AppState): void {
    const validated = appStateSchema.parse(candidate)
    this.#store.store = validated
    this.#state = validated
  }
}
