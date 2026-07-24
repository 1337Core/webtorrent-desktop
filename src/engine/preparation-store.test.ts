import { describe, expect, it } from 'vitest'
import { engineCommandResultSchema } from '../shared/engine-api'
import type { ValidatedTorrentMetadata } from './torrent-metadata'
import {
  PREPARATION_LIMITS,
  PreparationStore,
  PreparationStoreError,
  type PreparationLifecycleState,
  type PreparationSourcePolicy,
  type PreparationStoreErrorCode,
  type PreparationWarning
} from './preparation-store'

const START_TIME = 1_000_000
const LOCAL_SOURCE_POLICY: PreparationSourcePolicy = { kind: 'local-torrent' }
const OPEN_STATE: PreparationLifecycleState = 'open'
const WEB_SEED_DISABLED_WARNING: PreparationWarning = 'WEB_SEED_DISABLED'

function infoHash(index: number): string {
  return index.toString(16).padStart(40, '0')
}

function metadata(
  index: number,
  options: {
    byteLength?: number
    fileCount?: number
    pathLength?: number
    private?: boolean
  } = {}
): ValidatedTorrentMetadata {
  const fileCount = options.fileCount ?? 1
  const pathLength = options.pathLength ?? 0
  const files = Array.from({ length: fileCount }, (_value, fileIndex) => {
    const suffix = `/${fileIndex.toString().padStart(5, '0')}`
    const padding = 'p'.repeat(Math.max(0, pathLength - suffix.length))
    return {
      index: fileIndex,
      length: 10,
      offset: fileIndex * 10,
      path: pathLength > 0 ? `${padding}${suffix}` : `root/file-${fileIndex}`
    }
  })
  return {
    announceTiers: [['https://tracker.example/announce']],
    files,
    infoHash: infoHash(index),
    length: files.reduce((total, file) => total + file.length, 0),
    name: `torrent-${index}`,
    pieceCount: 1,
    pieceLength: 16_384,
    private: options.private ?? false,
    torrentBytes: new Uint8Array(options.byteLength ?? 32).fill(index),
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

function expectStoreError(
  operation: () => unknown,
  code: PreparationStoreErrorCode
): void {
  expect(operation).toThrowError(
    expect.objectContaining({
      code,
      name: PreparationStoreError.name
    })
  )
}

describe('PreparationStore', () => {
  it('owns sanitized metadata with an empty initial selection and policy flags', () => {
    let now = START_TIME
    const sourceMetadata = metadata(1)
    const store = new PreparationStore({
      createId: idFactory(),
      now: () => now
    })

    const created = store.create({
      metadata: sourceMetadata,
      sourcePolicy: {
        allowHttp: true,
        allowPrivateNetwork: false,
        kind: 'remote-torrent'
      },
      warnings: [WEB_SEED_DISABLED_WARNING, WEB_SEED_DISABLED_WARNING]
    })
    sourceMetadata.torrentBytes.fill(255)
    now += 1

    expect(created).toMatchObject({
      expiresAtMs: START_TIME + PREPARATION_LIMITS.ttlMs,
      lifecycleState: OPEN_STATE,
      selectedFileCount: 0,
      sourcePolicy: {
        allowHttp: true,
        allowPrivateNetwork: false,
        kind: 'remote-torrent'
      },
      warnings: ['WEB_SEED_DISABLED']
    })
    expect(store.retainedTorrentBytes).toBe(32)
    const reservation = store.beginCommit(created.preparationId)
    expect(reservation.metadata.torrentBytes).toEqual(
      new Uint8Array(32).fill(1)
    )
  })

  it('enforces one preparation per info hash and releases it on discard', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const created = store.create({
      metadata: metadata(2),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })

    expectStoreError(
      () =>
        store.create({
          metadata: metadata(2),
          sourcePolicy: LOCAL_SOURCE_POLICY
        }),
      'DUPLICATE_INFO_HASH'
    )

    expect(store.discard(created.preparationId).preparationId).toBe(
      created.preparationId
    )
    expect(store.size).toBe(0)
    expect(store.retainedTorrentBytes).toBe(0)
    expect(
      store.create({
        metadata: metadata(2),
        sourcePolicy: LOCAL_SOURCE_POLICY
      }).infoHash
    ).toBe(infoHash(2))
  })

  it('enforces the preparation-count and retained-byte limits', () => {
    const countStore = new PreparationStore({ createId: idFactory() })
    for (let index = 1; index <= PREPARATION_LIMITS.preparations; index += 1) {
      countStore.create({
        metadata: metadata(index),
        sourcePolicy: LOCAL_SOURCE_POLICY
      })
    }
    expectStoreError(
      () =>
        countStore.create({
          metadata: metadata(99),
          sourcePolicy: LOCAL_SOURCE_POLICY
        }),
      'CAPACITY_EXCEEDED'
    )

    const byteStore = new PreparationStore({ createId: idFactory() })
    byteStore.create({
      metadata: metadata(1, { byteLength: 10_000_000 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    byteStore.create({
      metadata: metadata(2, { byteLength: 10_000_000 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    expect(byteStore.retainedTorrentBytes).toBe(20_000_000)
    expectStoreError(
      () =>
        byteStore.create({
          metadata: metadata(3, { byteLength: 1 }),
          sourcePolicy: LOCAL_SOURCE_POLICY
        }),
      'CAPACITY_EXCEEDED'
    )
  })

  it('pages files deterministically within item and UTF-8 path limits', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const created = store.create({
      metadata: metadata(3, { fileCount: 70 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })

    const first = store.pageFiles(created.preparationId, {
      cursor: 0,
      limit: 64
    })
    const second = store.pageFiles(created.preparationId, {
      cursor: first.nextCursor ?? 0,
      limit: 64
    })

    expect(first.items).toHaveLength(64)
    expect(first.items.map(file => file.index)).toEqual(
      Array.from({ length: 64 }, (_value, index) => index)
    )
    expect(first.nextCursor).toBe(64)
    expect(second.items.map(file => file.index)).toEqual([
      64, 65, 66, 67, 68, 69
    ])
    expect(second.nextCursor).toBeNull()
    expect(
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'get-preparation-files',
          value: first
        }
      }).success
    ).toBe(true)

    const longPathStore = new PreparationStore({ createId: idFactory() })
    const longPathPreparation = longPathStore.create({
      metadata: metadata(4, { fileCount: 20, pathLength: 3_500 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    const page = longPathStore.pageFiles(longPathPreparation.preparationId, {
      cursor: 0,
      limit: 64
    })
    const pathBytes = page.items.reduce(
      (total, file) => total + new TextEncoder().encode(file.path).byteLength,
      0
    )
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.items.length).toBeLessThan(20)
    expect(pathBytes).toBeLessThanOrEqual(PREPARATION_LIMITS.filePagePathBytes)
    expect(page.nextCursor).toBe(page.items.length)
  })

  it('validates every selection change before applying the batch', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const created = store.create({
      metadata: metadata(5, { fileCount: 4 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })

    expect(
      store.updateSelection(created.preparationId, [
        { index: 3, selected: true },
        { index: 1, selected: true }
      ]).selectedFileCount
    ).toBe(2)
    expect(
      store
        .pageFiles(created.preparationId, { cursor: 0, limit: 4 })
        .items.map(file => file.selected)
    ).toEqual([false, true, false, true])

    expectStoreError(
      () =>
        store.updateSelection(created.preparationId, [
          { index: 1, selected: false },
          { index: 1, selected: true }
        ]),
      'INVALID_SELECTION'
    )
    expectStoreError(
      () =>
        store.updateSelection(created.preparationId, [
          { index: 1, selected: false },
          { index: 99, selected: true }
        ]),
      'INVALID_SELECTION'
    )
    expect(store.get(created.preparationId).selectedFileCount).toBe(2)
    expectStoreError(
      () =>
        store.updateSelection(
          created.preparationId,
          Array.from(
            { length: PREPARATION_LIMITS.selectionChanges + 1 },
            (_value, index) => ({ index, selected: true })
          )
        ),
      'INVALID_SELECTION'
    )
  })

  it('atomically reserves, rolls back, and consumes commit state', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const created = store.create({
      metadata: metadata(6, { fileCount: 3 }),
      sourcePolicy: {
        allowDhtExposure: true,
        allowPrivateNetwork: false,
        kind: 'magnet'
      },
      warnings: ['DHT_EXPOSURE_USED']
    })
    store.updateSelection(created.preparationId, [
      { index: 2, selected: true },
      { index: 0, selected: true }
    ])

    const firstReservation = store.beginCommit(created.preparationId)
    expect(firstReservation.selectedIndexes).toEqual([0, 2])
    expect(store.get(created.preparationId).lifecycleState).toBe('committing')
    expectStoreError(
      () => store.beginCommit(created.preparationId),
      'STATE_CONFLICT'
    )
    expectStoreError(
      () => store.discard(created.preparationId),
      'STATE_CONFLICT'
    )
    expectStoreError(
      () =>
        store.updateSelection(created.preparationId, [
          { index: 1, selected: true }
        ]),
      'STATE_CONFLICT'
    )

    expect(
      store.rollbackCommitBeforeMetadata(firstReservation)?.lifecycleState
    ).toBe('open')
    const secondReservation = store.beginCommit(created.preparationId)
    expectStoreError(
      () => store.consumeCommit(firstReservation),
      'STATE_CONFLICT'
    )
    expect(store.consumeCommit(secondReservation)).toMatchObject({
      lifecycleState: 'committing',
      preparationId: created.preparationId,
      selectedFileCount: 2
    })
    expect(store.size).toBe(0)
    expect(store.retainedTorrentBytes).toBe(0)
  })

  it('does not lend mutable store-owned metadata to commit code', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const created = store.create({
      metadata: metadata(11, { fileCount: 2 }),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    const firstReservation = store.beginCommit(created.preparationId)
    firstReservation.metadata.torrentBytes.fill(255)
    firstReservation.metadata.files[0]!.path = 'mutated/path'

    store.rollbackCommitBeforeMetadata(firstReservation)
    const secondReservation = store.beginCommit(created.preparationId)

    expect(secondReservation.metadata.torrentBytes).toEqual(
      new Uint8Array(32).fill(11)
    )
    expect(secondReservation.metadata.files[0]?.path).toBe('root/file-0')
    expect(store.retainedTorrentBytes).toBe(32)
  })

  it('expires open records at the exact TTL and releases duplicate reservations', () => {
    let now = START_TIME
    const store = new PreparationStore({
      createId: idFactory(),
      now: () => now
    })
    const first = store.create({
      metadata: metadata(7),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })

    now = first.expiresAtMs - 1
    expect(store.expire()).toEqual([])
    now = first.expiresAtMs
    expect(store.expire().map(item => item.preparationId)).toEqual([
      first.preparationId
    ])
    expect(store.size).toBe(0)
    expect(store.retainedTorrentBytes).toBe(0)
    expect(
      store.create({
        metadata: metadata(7),
        sourcePolicy: LOCAL_SOURCE_POLICY
      }).infoHash
    ).toBe(infoHash(7))
  })

  it('protects a committing record from expiry but drops an expired rollback', () => {
    let now = START_TIME
    const store = new PreparationStore({
      createId: idFactory(),
      now: () => now
    })
    const created = store.create({
      metadata: metadata(8),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    const reservation = store.beginCommit(created.preparationId)

    now = created.expiresAtMs
    expect(store.expire()).toEqual([])
    expect(store.size).toBe(1)
    expect(store.rollbackCommitBeforeMetadata(reservation)).toBeNull()
    expect(store.size).toBe(0)
    expect(store.retainedTorrentBytes).toBe(0)
  })

  it('clears all retained records without retaining commit metadata internally', () => {
    const store = new PreparationStore({ createId: idFactory() })
    const first = store.create({
      metadata: metadata(9),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    store.create({
      metadata: metadata(10),
      sourcePolicy: LOCAL_SOURCE_POLICY
    })
    store.beginCommit(first.preparationId)

    store.clear()

    expect(store.size).toBe(0)
    expect(store.retainedTorrentBytes).toBe(0)
    expectStoreError(() => store.get(first.preparationId), 'NOT_FOUND')
  })
})
