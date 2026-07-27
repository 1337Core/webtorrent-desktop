import { describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  EngineCommandResult,
  TorrentRecord
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { AppStateStore } from './state-store'
import { TorrentLibrary } from './torrent-library'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const OTHER_HASH = 'fedcba9876543210fedcba9876543210fedcba98'

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

/** An in-memory stand-in for the durable document. */
function fakeStore(initial: ReadonlyArray<TorrentRecord> = []): {
  records: TorrentRecord[]
  store: AppStateStore
} {
  const records = [...initial]
  const store = {
    listTorrents: () => records.map(record => ({ ...record })),
    removeTorrent: (infoHash: string) => {
      const index = records.findIndex(record => record.infoHash === infoHash)
      if (index === -1) return false
      records.splice(index, 1)
      return true
    },
    upsertTorrent: (record: TorrentRecord) => {
      const index = records.findIndex(
        existing => existing.infoHash === record.infoHash
      )
      if (index === -1) records.push(record)
      else records[index] = record
      return undefined as never
    }
  } as unknown as AppStateStore
  return { records, store }
}

function torrent(
  overrides: Partial<{ name: string; state: string }> = {}
): Record<string, unknown> {
  return {
    downloadSpeed: 0,
    downloaded: 0,
    fileCount: 1,
    infoHash: INFO_HASH,
    length: 10,
    name: overrides.name ?? 'Example payload',
    peerCount: 0,
    private: false,
    progress: 0,
    selectedFileCount: 1,
    state: overrides.state ?? 'downloading',
    timeRemainingMs: null,
    uploadSpeed: 0,
    uploaded: 0
  }
}

function committed(): EngineCommandResult {
  return {
    ok: true,
    result: {
      command: 'commit-preparation',
      value: {
        preparationId: '00000000-0000-4000-8000-000000000001',
        torrent: torrent()
      }
    }
  } as unknown as EngineCommandResult
}

function record(overrides: Partial<TorrentRecord> = {}): TorrentRecord {
  return {
    addedAtMs: 1_000,
    destinationRoot: '/Users/owner/Downloads',
    infoHash: INFO_HASH,
    name: 'Example payload',
    paused: false,
    private: false,
    ...overrides
  }
}

describe('TorrentLibrary', () => {
  it('records a committed torrent with the destination the owner chose', () => {
    const { records, store } = fakeStore()
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      now: () => 4_242,
      stateStore: store
    })

    library.record(
      {
        command: 'commit-preparation',
        payload: {
          destinationRoot: '/Users/owner/Downloads',
          preparationId: '00000000-0000-4000-8000-000000000001'
        }
      },
      committed()
    )

    expect(records).toEqual([
      {
        addedAtMs: 4_242,
        destinationRoot: '/Users/owner/Downloads',
        infoHash: INFO_HASH,
        name: 'Example payload',
        paused: false,
        private: false
      }
    ])
  })

  it('records a created torrent against the root it seeds from', () => {
    const { records, store } = fakeStore()
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })

    library.record(
      {
        command: 'create-torrent',
        payload: {
          allowHttpTrackers: false,
          allowPrivateNetwork: false,
          announceTiers: [],
          destinationRoot: '/Users/owner/Movies/clip.mp4',
          filterJunkFiles: true,
          operationId: '00000000-0000-4000-8000-000000000030',
          private: false,
          sourcePath: '/Users/owner/Movies/clip.mp4'
        }
      },
      {
        ok: true,
        result: {
          command: 'create-torrent',
          value: {
            operationId: '00000000-0000-4000-8000-000000000030',
            torrent: torrent({ state: 'seeding' })
          }
        }
      } as unknown as EngineCommandResult
    )

    expect(records[0]?.destinationRoot).toBe('/Users/owner/Movies')
  })

  it('keeps the original added time and tracks the paused intent', () => {
    const { records, store } = fakeStore([record({ addedAtMs: 5 })])
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      now: () => 9_999,
      stateStore: store
    })

    library.record(
      { command: 'pause-torrent', payload: { infoHash: INFO_HASH } },
      {
        ok: true,
        result: {
          command: 'pause-torrent',
          value: torrent({ state: 'paused' })
        }
      } as unknown as EngineCommandResult
    )
    expect(records[0]?.paused).toBe(true)

    library.record(
      { command: 'resume-torrent', payload: { infoHash: INFO_HASH } },
      {
        ok: true,
        result: { command: 'resume-torrent', value: torrent() }
      } as unknown as EngineCommandResult
    )
    expect(records[0]?.paused).toBe(false)
    expect(records[0]?.addedAtMs).toBe(5)
  })

  it('drops a removed torrent and ignores a failed command', () => {
    const { records, store } = fakeStore([record()])
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })

    library.record(
      {
        command: 'remove-torrent',
        payload: { deleteData: false, infoHash: INFO_HASH }
      },
      {
        ok: false,
        error: {
          command: 'remove-torrent',
          code: 'STATE_CONFLICT',
          displayMessage: 'Not now.',
          retryable: false
        }
      } as EngineCommandResult
    )
    expect(records).toHaveLength(1)

    library.record(
      {
        command: 'remove-torrent',
        payload: { deleteData: false, infoHash: INFO_HASH }
      },
      {
        ok: true,
        result: {
          command: 'remove-torrent',
          value: { infoHash: INFO_HASH, removed: true }
        }
      } as EngineCommandResult
    )
    expect(records).toEqual([])
  })

  it('rebuilds every recorded torrent with its saved intent', async () => {
    const { store } = fakeStore([
      record(),
      record({ infoHash: OTHER_HASH, paused: true })
    ])
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })
    const executed: EngineCommand[] = []

    const report = await library.restore(operation => {
      executed.push(operation)
      return Promise.resolve({
        ok: true,
        result: {
          command: 'restore-torrent',
          value: { infoHash: INFO_HASH, torrent: torrent() }
        }
      } as unknown as EngineCommandResult)
    })

    expect(report).toEqual({ dropped: 0, restored: 2 })
    expect(executed).toEqual([
      {
        command: 'restore-torrent',
        payload: {
          destinationRoot: '/Users/owner/Downloads',
          infoHash: INFO_HASH,
          paused: false
        }
      },
      {
        command: 'restore-torrent',
        payload: {
          destinationRoot: '/Users/owner/Downloads',
          infoHash: OTHER_HASH,
          paused: true
        }
      }
    ])
  })

  it('drops a torrent whose archived bytes are gone', async () => {
    const { records, store } = fakeStore([record()])
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })

    const report = await library.restore(() =>
      Promise.resolve({
        ok: false,
        error: {
          command: 'restore-torrent',
          code: 'NOT_FOUND',
          displayMessage: 'The saved torrent file is missing; add it again.',
          retryable: false
        }
      } as EngineCommandResult)
    )

    expect(report).toEqual({ dropped: 1, restored: 0 })
    expect(records).toEqual([])
  })

  it('keeps a torrent the engine could not restore for another reason', async () => {
    const { records, store } = fakeStore([record()])
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })

    const report = await library.restore(() =>
      Promise.resolve({
        ok: false,
        error: {
          command: 'restore-torrent',
          code: 'ENGINE_NOT_READY',
          displayMessage: 'The torrent engine is not ready.',
          retryable: true
        }
      } as EngineCommandResult)
    )

    expect(report).toEqual({ dropped: 0, restored: 0 })
    expect(records).toHaveLength(1)
  })

  it('never fails a command because the library could not be written', () => {
    const store = {
      listTorrents: () => [],
      removeTorrent: () => false,
      upsertTorrent: () => {
        throw new Error('The torrent library is full')
      }
    } as unknown as AppStateStore
    const library = new TorrentLibrary({
      diagnostics: diagnostics(),
      stateStore: store
    })

    expect(() =>
      library.record(
        {
          command: 'commit-preparation',
          payload: {
            destinationRoot: '/Users/owner/Downloads',
            preparationId: '00000000-0000-4000-8000-000000000001'
          }
        },
        committed()
      )
    ).not.toThrow()
  })
})
