import path from 'node:path'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_STATE } from '../shared/contracts'
import type { Diagnostics } from './diagnostics'

const electronMock = vi.hoisted(() => {
  const state = { rendererListenerCount: 1 }
  return {
    listenerCount: vi.fn((channel: string) =>
      channel === 'electron-store-get-data' ? state.rendererListenerCount : 0
    ),
    removeAllListeners: vi.fn((channel: string) => {
      if (channel === 'electron-store-get-data') {
        state.rendererListenerCount = 0
      }
    }),
    state
  }
})
const storeMock = vi.hoisted(() => ({
  configFileMode: undefined as number | undefined,
  failWrites: false
}))

vi.mock('electron', () => ({
  ipcMain: {
    listenerCount: electronMock.listenerCount,
    removeAllListeners: electronMock.removeAllListeners
  }
}))

vi.mock('electron-store', async () => {
  const fs = await import('node:fs')
  const nodePath = await import('node:path')

  return {
    default: class MockElectronStore<T extends Record<string, unknown>> {
      readonly path: string
      #store: T

      constructor(options: {
        configFileMode?: number
        cwd: string
        defaults: T
        name: string
      }) {
        this.path = nodePath.join(options.cwd, `${options.name}.json`)
        storeMock.configFileMode = options.configFileMode
        this.#store = fs.existsSync(this.path)
          ? (JSON.parse(fs.readFileSync(this.path, 'utf8')) as T)
          : structuredClone(options.defaults)
        if (!fs.existsSync(this.path)) {
          fs.writeFileSync(this.path, JSON.stringify(this.#store), {
            mode: options.configFileMode
          })
        }
      }

      get store(): T {
        return structuredClone(this.#store)
      }

      set store(value: T) {
        if (storeMock.failWrites) throw new Error('simulated write failure')
        fs.writeFileSync(this.path, JSON.stringify(value))
        this.#store = structuredClone(value)
      }
    }
  }
})

import { AppStateStore } from './state-store'

const temporaryDirectories: string[] = []

async function createUserData(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'webtorrent-updated-state-')
  )
  temporaryDirectories.push(directory)
  return directory
}

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

async function writeRawState(
  userDataPath: string,
  contents: string
): Promise<string> {
  const stateDirectory = path.join(userDataPath, 'state')
  await mkdir(stateDirectory, { recursive: true })
  const statePath = path.join(stateDirectory, 'app-state.json')
  await writeFile(statePath, contents)
  return statePath
}

beforeEach(() => {
  storeMock.configFileMode = undefined
  storeMock.failWrites = false
  electronMock.state.rendererListenerCount = 1
  electronMock.listenerCount.mockClear()
  electronMock.removeAllListeners.mockClear()
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true }))
  )
})

function torrentRecord(
  infoHash: string,
  overrides: Partial<{
    addedAtMs: number
    destinationRoot: string
    name: string
    paused: boolean
    private: boolean
  }> = {}
): {
  addedAtMs: number
  destinationRoot: string
  infoHash: string
  name: string
  paused: boolean
  private: boolean
} {
  return {
    addedAtMs: 1_000,
    destinationRoot: '/Users/owner/Downloads',
    infoHash,
    name: `torrent-${infoHash.slice(0, 4)}`,
    paused: true,
    private: false,
    ...overrides
  }
}

describe('AppStateStore', () => {
  it('records only an absolute normalized download root', async () => {
    const store = new AppStateStore(await createUserData(), diagnostics())

    expect(store.snapshot().preferences.downloadRoot).toBeNull()
    const updated = store.setDownloadRoot('/Users/owner/Downloads')
    expect(updated.preferences.downloadRoot).toBe('/Users/owner/Downloads')
    expect(updated.revision).toBe(1)

    // Writing the same root again is not a revision.
    expect(store.setDownloadRoot('/Users/owner/Downloads').revision).toBe(1)
    for (const invalid of ['relative/path', '/Users/owner/./Downloads', '']) {
      expect(() => store.setDownloadRoot(invalid)).toThrow()
    }
  })

  it('keeps a durable torrent library ordered by info hash', async () => {
    const store = new AppStateStore(await createUserData(), diagnostics())
    const first = 'f'.repeat(40)
    const second = '0'.repeat(40)

    store.upsertTorrent(torrentRecord(first))
    const snapshot = store.upsertTorrent(torrentRecord(second))

    expect(snapshot.library.torrents.map(entry => entry.infoHash)).toEqual([
      second,
      first
    ])
    expect(snapshot.revision).toBe(2)
    expect(store.listTorrents()).toHaveLength(2)
  })

  it('replaces a record instead of duplicating its info hash', async () => {
    const store = new AppStateStore(await createUserData(), diagnostics())
    const infoHash = 'a'.repeat(40)

    store.upsertTorrent(torrentRecord(infoHash))
    store.upsertTorrent(
      torrentRecord(infoHash, { name: 'renamed', paused: false })
    )

    expect(store.listTorrents()).toEqual([
      expect.objectContaining({ name: 'renamed', paused: false })
    ])
  })

  it('removes a record idempotently and bounds the library', async () => {
    const store = new AppStateStore(await createUserData(), diagnostics())
    const infoHash = 'b'.repeat(40)
    store.upsertTorrent(torrentRecord(infoHash))

    expect(store.removeTorrent(infoHash)).toBe(true)
    expect(store.removeTorrent(infoHash)).toBe(false)
    expect(store.listTorrents()).toEqual([])

    for (let index = 0; index < 64; index += 1) {
      store.upsertTorrent(torrentRecord(index.toString(16).padStart(40, '0')))
    }
    expect(() => store.upsertTorrent(torrentRecord('c'.repeat(40)))).toThrow()
  })

  it('creates private defaults and removes renderer compatibility IPC', async () => {
    const userDataPath = await createUserData()
    const store = new AppStateStore(userDataPath, diagnostics())

    expect(store.snapshot()).toEqual(DEFAULT_APP_STATE)
    expect(electronMock.removeAllListeners).toHaveBeenCalledWith(
      'electron-store-get-data'
    )
    expect(electronMock.state.rendererListenerCount).toBe(0)
    expect((await lstat(path.join(userDataPath, 'state'))).mode & 0o777).toBe(
      0o700
    )
    expect(
      (await lstat(path.join(userDataPath, 'state', 'app-state.json'))).mode &
        0o777
    ).toBe(0o600)
    expect(storeMock.configFileMode).toBe(0o600)
  })

  it('rejects unexpected renderer compatibility listener fan-out', async () => {
    const userDataPath = await createUserData()
    electronMock.state.rendererListenerCount = 2

    expect(() => new AppStateStore(userDataPath, diagnostics())).toThrow(
      'unexpected renderer compatibility IPC'
    )
    expect(electronMock.removeAllListeners).not.toHaveBeenCalled()
  })

  it('loads valid state and persists revised window bounds', async () => {
    const userDataPath = await createUserData()
    const initial = {
      ...DEFAULT_APP_STATE,
      revision: 3
    }
    const statePath = await writeRawState(userDataPath, JSON.stringify(initial))
    const store = new AppStateStore(userDataPath, diagnostics())

    store.setWindowBounds({ x: 10, y: 20, width: 1000, height: 700 })

    expect(store.snapshot()).toMatchObject({
      revision: 4,
      window: {
        main: {
          normalBounds: { x: 10, y: 20, width: 1000, height: 700 }
        }
      }
    })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(
      store.snapshot()
    )
    expect((await lstat(statePath)).mode & 0o777).toBe(0o600)
  })

  it('quarantines malformed state byte-for-byte before using defaults', async () => {
    const userDataPath = await createUserData()
    const malformed = '{"schemaVersion":1'
    await writeRawState(userDataPath, malformed)

    const store = new AppStateStore(userDataPath, diagnostics())
    const entries = await readdir(path.join(userDataPath, 'state'))
    const quarantine = entries.find(name => name.includes('.invalid-'))

    expect(store.snapshot()).toEqual(DEFAULT_APP_STATE)
    expect(quarantine).toBeDefined()
    expect(
      await readFile(path.join(userDataPath, 'state', quarantine ?? ''), 'utf8')
    ).toBe(malformed)
  })

  it('refuses a future schema without modifying the original', async () => {
    const userDataPath = await createUserData()
    const future = JSON.stringify({
      ...DEFAULT_APP_STATE,
      schemaVersion: 2
    })
    const statePath = await writeRawState(userDataPath, future)

    expect(() => new AppStateStore(userDataPath, diagnostics())).toThrow(
      'newer schema version'
    )
    expect(await readFile(statePath, 'utf8')).toBe(future)
  })

  it('keeps the published and on-disk state unchanged when persistence fails', async () => {
    const userDataPath = await createUserData()
    const store = new AppStateStore(userDataPath, diagnostics())
    const before = store.snapshot()
    const statePath = path.join(userDataPath, 'state', 'app-state.json')
    const diskBefore = await readFile(statePath, 'utf8')
    storeMock.failWrites = true

    expect(() =>
      store.setWindowBounds({ x: 10, y: 20, width: 1000, height: 700 })
    ).toThrow('simulated write failure')
    expect(store.snapshot()).toEqual(before)
    expect(await readFile(statePath, 'utf8')).toBe(diskBefore)
  })

  it('rejects symbolic-link state paths', async () => {
    const userDataPath = await createUserData()
    const targetDirectory = await createUserData()
    await chmod(targetDirectory, 0o700)
    await symlink(targetDirectory, path.join(userDataPath, 'state'))

    expect(() => new AppStateStore(userDataPath, diagnostics())).toThrow(
      'real directory'
    )
  })
})
