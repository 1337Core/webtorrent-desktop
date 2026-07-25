import { describe, expect, it, vi } from 'vitest'
import {
  engineCommandResultSchema,
  engineEventSchema,
  engineResultMatchesOperation,
  type EngineCommand,
  type EngineCommandResult,
  type EngineEvent
} from '../shared/engine-api'
import {
  PREPARATION_LIMITS,
  PreparationStore,
  type PreparationSnapshot
} from './preparation-store'
import { EngineRuntime } from './runtime'
import { DiskTorrentError } from './disk-torrent'
import type { TorrentManager } from './torrent-manager'
import { TorrentManager as TorrentManagerImpl } from './torrent-manager'
import type { ValidatedTorrentMetadata } from './torrent-metadata'
import {
  TorrentPreparationService,
  TorrentPreparationServiceError,
  type TorrentPreparationServiceErrorCode
} from './torrent-preparation-service'

const START_TIME = 1_000_000
const PREPARATION_ID = '00000000-0000-4000-8000-000000000001'
const INFO_HASH = '1111111111111111111111111111111111111111'
const OTHER_INFO_HASH = '2222222222222222222222222222222222222222'
const LEASE_ID = '00000000-0000-4000-8000-000000000002'
const OPERATION_ID = '00000000-0000-4000-8000-000000000003'

function metadata(
  options: Readonly<{
    fileCount?: number
    infoHash?: string
    name?: string
  }> = {}
): ValidatedTorrentMetadata {
  const files = Array.from(
    { length: options.fileCount ?? 2 },
    (_value, index) => ({
      index,
      length: index + 1,
      offset: (index * (index + 1)) / 2,
      path: `root/file-${index}.txt`
    })
  )
  return {
    announceTiers: [['https://tracker.example/announce']],
    files,
    infoHash: options.infoHash ?? INFO_HASH,
    length: files.reduce((total, file) => total + file.length, 0),
    name: options.name ?? 'example',
    pieceCount: 1,
    pieceLength: 16_384,
    private: false,
    torrentBytes: new Uint8Array([1, 2, 3]),
    warnings: [],
    webSeeds: []
  }
}

function idFactory(): () => string {
  let next = 0
  return () => {
    next += 1
    return `00000000-0000-4000-8000-${next.toString().padStart(12, '0')}`
  }
}

function localOpen(
  path = '/authorized/example.torrent'
): Extract<EngineCommand, { command: 'open-preparation' }> {
  return {
    command: 'open-preparation',
    payload: {
      source: {
        kind: 'local-torrent',
        path
      }
    }
  }
}

function remoteOpen(): Extract<EngineCommand, { command: 'open-preparation' }> {
  return {
    command: 'open-preparation',
    payload: {
      source: {
        allowHttp: false,
        allowPrivateNetwork: false,
        kind: 'remote-torrent',
        url: 'https://source.example/example.torrent'
      }
    }
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function expectStrictResult(
  operation: EngineCommand,
  result: EngineCommandResult
): void {
  expect(engineCommandResultSchema.safeParse(result).success).toBe(true)
  expect(engineResultMatchesOperation(result, operation)).toBe(true)
}

function errorCode(result: EngineCommandResult): string | undefined {
  return result.ok ? undefined : result.error.code
}

function createPreparationHarness(
  options: {
    emitEvent?: (event: EngineEvent) => void
    fileCount?: number
    now?: () => number
  } = {}
): {
  readLocalTorrent: ReturnType<typeof vi.fn>
  runtime: EngineRuntime
  store: PreparationStore
} {
  const store = new PreparationStore({
    createId: idFactory(),
    now: options.now
  })
  const readLocalTorrent = vi.fn(async () => new Uint8Array([1]))
  const runtime = new EngineRuntime({
    emitEvent: options.emitEvent,
    preparationStore: store,
    torrentManager: emptyTorrentManager(),
    createPreparationService: ownedStore =>
      new TorrentPreparationService({
        readLocalTorrent,
        store: ownedStore,
        validateMetadata: async () => metadata({ fileCount: options.fileCount })
      })
  })
  return { readLocalTorrent, runtime, store }
}

/** A manager with no sessions: every torrent command reports NOT_FOUND. */
function emptyTorrentManager(): TorrentManager {
  return new TorrentManagerImpl({
    resolveClient: () => ({
      add: () => {
        throw new Error('No client is attached in this test')
      }
    })
  })
}

describe('EngineRuntime', () => {
  it('opens local preparations and exposes only the strict public summary', async () => {
    const secretPath = '/authorized/private/noah/example.torrent'
    const operation = localOpen(secretPath)
    const { readLocalTorrent, runtime } = createPreparationHarness()

    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(result).toEqual({
      ok: true,
      result: {
        command: 'open-preparation',
        value: {
          expiresAtMs: expect.any(Number),
          fileCount: 2,
          infoHash: INFO_HASH,
          length: 3,
          name: 'example',
          preparationId: PREPARATION_ID,
          private: false,
          selectedFileCount: 0,
          warnings: []
        }
      }
    })
    expect(readLocalTorrent).toHaveBeenCalledOnce()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(secretPath)
    expect(serialized).not.toContain('lifecycleState')
    expect(serialized).not.toContain('sourcePolicy')
  })

  it('passes remote sources and cancellation through the preparation service', async () => {
    const operation = remoteOpen()
    const open = vi.fn(
      async (
        _source: Extract<
          EngineCommand,
          { command: 'open-preparation' }
        >['payload']['source'],
        _signal: AbortSignal
      ): Promise<PreparationSnapshot> => ({
        expiresAtMs: START_TIME + PREPARATION_LIMITS.ttlMs,
        fileCount: 1,
        infoHash: INFO_HASH,
        length: 1,
        lifecycleState: 'open',
        name: 'remote',
        preparationId: PREPARATION_ID,
        private: false,
        selectedFileCount: 0,
        sourcePolicy: {
          allowHttp: false,
          allowPrivateNetwork: false,
          kind: 'remote-torrent'
        },
        warnings: []
      })
    )
    const runtime = new EngineRuntime({
      createPreparationService: () => ({ open })
    })
    const callerSignal = signal()

    const result = await runtime.execute(operation, callerSignal)

    expectStrictResult(operation, result)
    expect(result.ok).toBe(true)
    expect(open).toHaveBeenCalledOnce()
    expect(open.mock.calls[0]?.[0]).toEqual(operation.payload.source)
    expect(open.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(open.mock.calls[0]?.[1].aborted).toBe(false)
  })

  it('pages files, updates selection, and discards through exact identities', async () => {
    const { runtime } = createPreparationHarness({ fileCount: 3 })
    const opened = await runtime.execute(localOpen(), signal())
    expect(opened.ok).toBe(true)

    const firstPage: EngineCommand = {
      command: 'get-preparation-files',
      payload: {
        cursor: 0,
        limit: 2,
        preparationId: PREPARATION_ID
      }
    }
    const pageResult = await runtime.execute(firstPage, signal())
    expectStrictResult(firstPage, pageResult)
    expect(pageResult).toEqual({
      ok: true,
      result: {
        command: 'get-preparation-files',
        value: {
          items: [
            {
              downloaded: 0,
              index: 0,
              length: 1,
              path: 'root/file-0.txt',
              progress: 0,
              selected: false
            },
            {
              downloaded: 0,
              index: 1,
              length: 2,
              path: 'root/file-1.txt',
              progress: 0,
              selected: false
            }
          ],
          nextCursor: 2,
          preparationId: PREPARATION_ID,
          total: 3
        }
      }
    })

    const update: EngineCommand = {
      command: 'update-preparation-selection',
      payload: {
        changes: [
          { index: 2, selected: true },
          { index: 0, selected: true }
        ],
        preparationId: PREPARATION_ID
      }
    }
    const updateResult = await runtime.execute(update, signal())
    expectStrictResult(update, updateResult)
    expect(updateResult).toEqual({
      ok: true,
      result: {
        command: 'update-preparation-selection',
        value: {
          preparationId: PREPARATION_ID,
          selectedFileCount: 2
        }
      }
    })

    const discard: EngineCommand = {
      command: 'discard-preparation',
      payload: { preparationId: PREPARATION_ID }
    }
    const discardResult = await runtime.execute(discard, signal())
    expectStrictResult(discard, discardResult)
    expect(discardResult).toEqual({
      ok: true,
      result: {
        command: 'discard-preparation',
        value: {
          discarded: true,
          preparationId: PREPARATION_ID
        }
      }
    })
  })

  it('returns an exact empty torrent page from the attached manager', async () => {
    const runtime = new EngineRuntime({ torrentManager: emptyTorrentManager() })
    const operation: EngineCommand = {
      command: 'list-torrents',
      payload: { cursor: 64, limit: 1 }
    }

    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(result).toEqual({
      ok: true,
      result: {
        command: 'list-torrents',
        value: {
          items: [],
          nextCursor: null,
          total: 0
        }
      }
    })
  })

  it('reports a missing torrent for every transfer command', async () => {
    const runtime = new EngineRuntime({ torrentManager: emptyTorrentManager() })
    const operations = [
      {
        command: 'get-torrent-files',
        payload: { cursor: 0, infoHash: INFO_HASH, limit: 50 }
      },
      { command: 'pause-torrent', payload: { infoHash: INFO_HASH } },
      { command: 'resume-torrent', payload: { infoHash: INFO_HASH } },
      {
        command: 'remove-torrent',
        payload: { deleteData: false, infoHash: INFO_HASH }
      }
    ] satisfies EngineCommand[]

    for (const operation of operations) {
      const result = await runtime.execute(operation, signal())
      expectStrictResult(operation, result)
      expect(errorCode(result)).toBe('NOT_FOUND')
    }
  })

  it('reports an unavailable engine when no clients are attached', async () => {
    const runtime = new EngineRuntime()
    const operation: EngineCommand = {
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    }

    const result = await runtime.execute(operation, signal())
    expectStrictResult(operation, result)
    expect(errorCode(result)).toBe('ENGINE_NOT_READY')
  })

  it('rejects magnet and info-hash preparation without invoking the service', async () => {
    const open = vi.fn()
    const runtime = new EngineRuntime({
      createPreparationService: () => ({ open })
    })
    const operations = [
      {
        command: 'open-preparation',
        payload: {
          source: {
            allowDhtExposure: false,
            allowPrivateNetwork: false,
            kind: 'magnet',
            magnet: `magnet:?xt=urn:btih:${INFO_HASH}`
          }
        }
      },
      {
        command: 'open-preparation',
        payload: {
          source: {
            allowDhtExposure: false,
            allowPrivateNetwork: false,
            infoHash: INFO_HASH,
            kind: 'info-hash'
          }
        }
      }
    ] satisfies EngineCommand[]

    for (const operation of operations) {
      const result = await runtime.execute(operation, signal())
      expectStrictResult(operation, result)
      expect(errorCode(result)).toBe('UNSUPPORTED')
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('commits an open preparation into an owned torrent session', async () => {
    const store = new PreparationStore({ createId: idFactory() })
    const prepared = metadata({ fileCount: 2 })
    const manager = {
      add: vi.fn(async () => ({
        downloadSpeed: 0,
        downloaded: 0,
        fileCount: 2,
        infoHash: INFO_HASH,
        length: prepared.length,
        name: prepared.name,
        peerCount: 0,
        private: false,
        progress: 0,
        selectedFileCount: 2,
        state: 'paused' as const,
        timeRemainingMs: null,
        uploadSpeed: 0,
        uploaded: 0
      })),
      closeAll: vi.fn(async () => undefined)
    }
    const emitEvent = vi.fn()
    const runtime = new EngineRuntime({
      emitEvent,
      preparationStore: store,
      torrentManager: manager as unknown as TorrentManager,
      createPreparationService: ownedStore =>
        new TorrentPreparationService({
          readLocalTorrent: async () => new Uint8Array([1]),
          store: ownedStore,
          validateMetadata: async () => prepared
        })
    })

    await runtime.execute(localOpen(), signal())
    const operation: EngineCommand = {
      command: 'commit-preparation',
      payload: {
        destinationRoot: '/authorized/downloads',
        preparationId: PREPARATION_ID
      }
    }
    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(result).toMatchObject({
      ok: true,
      result: {
        command: 'commit-preparation',
        value: {
          preparationId: PREPARATION_ID,
          torrent: { infoHash: INFO_HASH }
        }
      }
    })
    expect(manager.add).toHaveBeenCalledWith({
      destinationRoot: '/authorized/downloads',
      metadata: expect.objectContaining({ infoHash: INFO_HASH }) as unknown,
      selectedIndexes: []
    })
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'torrent-updated' })
    )
    expect(() => store.get(PREPARATION_ID)).toThrow()
  })

  it('reopens the preparation when the commit fails before metadata', async () => {
    const store = new PreparationStore({ createId: idFactory() })
    const prepared = metadata({ fileCount: 2 })
    const manager = {
      add: vi.fn(async () => {
        throw new DiskTorrentError('COMMIT_REJECTED', 'NAME_MISMATCH')
      }),
      closeAll: vi.fn(async () => undefined)
    }
    const runtime = new EngineRuntime({
      preparationStore: store,
      torrentManager: manager as unknown as TorrentManager,
      createPreparationService: ownedStore =>
        new TorrentPreparationService({
          readLocalTorrent: async () => new Uint8Array([1]),
          store: ownedStore,
          validateMetadata: async () => prepared
        })
    })

    await runtime.execute(localOpen(), signal())
    const operation: EngineCommand = {
      command: 'commit-preparation',
      payload: {
        destinationRoot: '/authorized/downloads',
        preparationId: PREPARATION_ID
      }
    }
    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(errorCode(result)).toBe('INPUT_INVALID')
    expect(store.get(PREPARATION_ID)).toMatchObject({
      lifecycleState: 'open'
    })
  })

  it('returns fixed unsupported results for every deferred command', async () => {
    const runtime = new EngineRuntime({ torrentManager: emptyTorrentManager() })
    const operations = [
      {
        command: 'create-torrent',
        payload: {
          allowHttpTrackers: false,
          allowPrivateNetwork: false,
          announceTiers: [],
          destinationRoot: '/authorized/downloads',
          filterJunkFiles: true,
          operationId: OPERATION_ID,
          private: false,
          sourcePath: '/authorized/source'
        }
      },
      {
        command: 'open-media',
        payload: { fileIndex: 0, infoHash: INFO_HASH }
      },
      {
        command: 'heartbeat-media',
        payload: { leaseId: LEASE_ID }
      },
      {
        command: 'close-media',
        payload: { leaseId: LEASE_ID }
      }
    ] satisfies EngineCommand[]

    for (const operation of operations) {
      const result = await runtime.execute(operation, signal())
      expectStrictResult(operation, result)
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'UNSUPPORTED',
          command: operation.command,
          displayMessage: 'This torrent operation is not available yet.',
          retryable: false
        }
      })
    }
  })

  it('emits exact expiry events at the next operation boundary', async () => {
    let now = START_TIME
    const emitEvent = vi.fn((_event: EngineEvent) => {
      throw new Error('A reporting callback must be contained')
    })
    const { runtime } = createPreparationHarness({
      emitEvent,
      now: () => now
    })
    const opened = await runtime.execute(localOpen(), signal())
    expect(opened.ok).toBe(true)
    now = START_TIME + PREPARATION_LIMITS.ttlMs

    const list: EngineCommand = {
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    }
    const listResult = await runtime.execute(list, signal())

    expectStrictResult(list, listResult)
    expect(listResult.ok).toBe(true)
    expect(emitEvent).toHaveBeenCalledWith({
      event: 'preparation-expired',
      payload: { preparationId: PREPARATION_ID }
    })
    expect(
      engineEventSchema.safeParse(emitEvent.mock.calls[0]?.[0]).success
    ).toBe(true)
    expect(JSON.stringify(emitEvent.mock.calls[0]?.[0])).not.toContain(
      'sourcePolicy'
    )

    const getFiles: EngineCommand = {
      command: 'get-preparation-files',
      payload: {
        cursor: 0,
        limit: 50,
        preparationId: PREPARATION_ID
      }
    }
    const missing = await runtime.execute(getFiles, signal())
    expectStrictResult(getFiles, missing)
    expect(errorCode(missing)).toBe('NOT_FOUND')
    expect(emitEvent).toHaveBeenCalledTimes(1)
  })

  it('maps every preparation-service failure to fixed public output', async () => {
    const cases: ReadonlyArray<
      readonly [TorrentPreparationServiceErrorCode, string, string, boolean]
    > = [
      ['ABORTED', 'ABORTED', 'The torrent operation was aborted.', false],
      [
        'ALREADY_EXISTS',
        'ALREADY_EXISTS',
        'This torrent is already being prepared.',
        false
      ],
      [
        'CAPACITY_EXCEEDED',
        'STATE_CONFLICT',
        'Too many torrent preparations are open.',
        true
      ],
      [
        'INPUT_INVALID',
        'INPUT_INVALID',
        'The torrent input is invalid.',
        false
      ],
      [
        'LOCAL_TORRENT_UNAVAILABLE',
        'PATH_NOT_AUTHORIZED',
        'The selected torrent file is not available.',
        false
      ],
      [
        'REMOTE_CONCURRENCY_LIMIT',
        'STATE_CONFLICT',
        'Too many remote torrent requests are active.',
        true
      ],
      [
        'REMOTE_TORRENT_UNAVAILABLE',
        'NOT_FOUND',
        'The remote torrent could not be loaded.',
        true
      ],
      [
        'UNSUPPORTED',
        'UNSUPPORTED',
        'This torrent operation is not available yet.',
        false
      ],
      [
        'INTERNAL',
        'INTERNAL',
        'The torrent engine could not complete the operation.',
        false
      ]
    ]

    for (const [internalCode, publicCode, displayMessage, retryable] of cases) {
      const runtime = new EngineRuntime({
        createPreparationService: () => ({
          open: async () => {
            throw new TorrentPreparationServiceError(internalCode)
          }
        })
      })
      const operation = localOpen('/private/secret/input.torrent')
      const result = await runtime.execute(operation, signal())
      expectStrictResult(operation, result)
      expect(result).toEqual({
        ok: false,
        error: {
          code: publicCode,
          command: 'open-preparation',
          displayMessage,
          retryable
        }
      })
      expect(JSON.stringify(result)).not.toContain('/private/secret')
    }
  })

  it('maps store failures without leaking lifecycle state or internals', async () => {
    const { runtime, store } = createPreparationHarness()
    const missingOperation: EngineCommand = {
      command: 'discard-preparation',
      payload: { preparationId: PREPARATION_ID }
    }
    const missing = await runtime.execute(missingOperation, signal())
    expectStrictResult(missingOperation, missing)
    expect(errorCode(missing)).toBe('NOT_FOUND')

    await runtime.execute(localOpen(), signal())
    const invalidSelection: EngineCommand = {
      command: 'update-preparation-selection',
      payload: {
        changes: [{ index: 99, selected: true }],
        preparationId: PREPARATION_ID
      }
    }
    const invalid = await runtime.execute(invalidSelection, signal())
    expectStrictResult(invalidSelection, invalid)
    expect(errorCode(invalid)).toBe('INPUT_INVALID')

    store.beginCommit(PREPARATION_ID)
    const stateConflict = await runtime.execute(invalidSelection, signal())
    expectStrictResult(invalidSelection, stateConflict)
    expect(stateConflict).toEqual({
      ok: false,
      error: {
        code: 'STATE_CONFLICT',
        command: 'update-preparation-selection',
        displayMessage:
          'The torrent preparation cannot be changed in its current state.',
        retryable: false
      }
    })
    expect(JSON.stringify(stateConflict)).not.toContain('committing')
  })

  it('contains unknown failures and never returns their internal text', async () => {
    const secret =
      'failed for /Users/noah/private.torrent at https://secret.example'
    const runtime = new EngineRuntime({
      createPreparationService: () => ({
        open: async () => {
          throw new Error(secret)
        }
      })
    })
    const operation = localOpen()

    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        command: 'open-preparation',
        displayMessage: 'The torrent engine could not complete the operation.',
        retryable: false
      }
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('reconstructs service snapshots so unexpected fields cannot cross IPC', async () => {
    const maliciousSnapshot = {
      expiresAtMs: START_TIME + PREPARATION_LIMITS.ttlMs,
      fileCount: 1,
      infoHash: OTHER_INFO_HASH,
      length: 1,
      lifecycleState: 'open',
      name: 'safe-name',
      preparationId: PREPARATION_ID,
      private: false,
      secretPath: '/Users/noah/private.torrent',
      selectedFileCount: 0,
      sourcePolicy: { kind: 'local-torrent' },
      sourceUrl: 'https://secret.example/input.torrent',
      warnings: []
    } as const satisfies PreparationSnapshot & {
      secretPath: string
      sourceUrl: string
    }
    const runtime = new EngineRuntime({
      createPreparationService: () => ({
        open: async () => maliciousSnapshot
      })
    })
    const operation = localOpen()

    const result = await runtime.execute(operation, signal())

    expectStrictResult(operation, result)
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secretPath')
    expect(serialized).not.toContain('sourceUrl')
    expect(serialized).not.toContain('sourcePolicy')
    expect(serialized).not.toContain('lifecycleState')
  })

  it('returns ABORTED before touching service or retained state', async () => {
    const open = vi.fn()
    const runtime = new EngineRuntime({
      createPreparationService: () => ({ open })
    })
    const controller = new AbortController()
    controller.abort()
    const operation = localOpen()

    const result = await runtime.execute(operation, controller.signal)

    expectStrictResult(operation, result)
    expect(errorCode(result)).toBe('ABORTED')
    expect(open).not.toHaveBeenCalled()
  })

  it('propagates cancellation during preparation as a redacted result', async () => {
    const started = Promise.withResolvers<void>()
    const operation = localOpen('/private/secret/cancelled.torrent')
    const runtime = new EngineRuntime({
      createPreparationService: () => ({
        open: async (_source, executionSignal) => {
          started.resolve()
          await new Promise<void>(resolve => {
            executionSignal.addEventListener('abort', () => resolve(), {
              once: true
            })
          })
          throw new Error('cancelled /private/secret/cancelled.torrent')
        }
      })
    })
    const controller = new AbortController()
    const execution = runtime.execute(operation, controller.signal)
    await started.promise

    controller.abort()
    const result = await execution

    expectStrictResult(operation, result)
    expect(errorCode(result)).toBe('ABORTED')
    expect(JSON.stringify(result)).not.toContain('/private/secret')
  })

  it('closes idempotently, clears state, and rejects later execution', async () => {
    const { runtime, store } = createPreparationHarness()
    await runtime.execute(localOpen(), signal())
    expect(store.size).toBe(1)

    const firstClose = runtime.close()
    const secondClose = runtime.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    expect(store.size).toBe(0)

    const operation: EngineCommand = {
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    }
    const unavailable = await runtime.execute(operation, signal())
    expectStrictResult(operation, unavailable)
    expect(errorCode(unavailable)).toBe('ENGINE_NOT_READY')

    const controller = new AbortController()
    controller.abort()
    const aborted = await runtime.execute(operation, controller.signal)
    expectStrictResult(operation, aborted)
    expect(errorCode(aborted)).toBe('ABORTED')
  })

  it('aborts and drains in-flight preparation before close completes', async () => {
    const started = Promise.withResolvers<void>()
    const runtime = new EngineRuntime({
      createPreparationService: () => ({
        open: async (_source, executionSignal) => {
          started.resolve()
          await new Promise<void>(resolve => {
            executionSignal.addEventListener('abort', () => resolve(), {
              once: true
            })
          })
          throw new TorrentPreparationServiceError('ABORTED')
        }
      })
    })
    const operation = remoteOpen()
    const execution = runtime.execute(operation, signal())
    await started.promise

    const close = runtime.close()
    const result = await execution
    await close

    expectStrictResult(operation, result)
    expect(errorCode(result)).toBe('ABORTED')
  })
})
