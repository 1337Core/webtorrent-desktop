import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChunkStore } from 'webtorrent'
import {
  GuardedStoreError,
  GuardedStoreSupervisor,
  type GuardedStoreGrant
} from './guarded-store'

const CHUNK_LENGTH = 8

let root = ''

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function grantFor(
  files: ReadonlyArray<{ length: number; path: string }>
): GuardedStoreGrant {
  let offset = 0
  const resolved = files.map((file, index) => {
    const entry = { index, length: file.length, offset, path: file.path }
    offset += file.length
    return entry
  })
  return {
    chunkLength: CHUNK_LENGTH,
    files: resolved,
    root,
    totalLength: offset
  }
}

function createStore(
  supervisor: GuardedStoreSupervisor,
  overrides: { chunkLength?: number; length?: number; token?: symbol } = {}
): ChunkStore {
  const Store = supervisor.storeConstructor()
  const options = {
    ...supervisor.storeOptions,
    length: overrides.length ?? supervisor.grant.totalLength
  }
  if (overrides.token !== undefined) options.guardedStoreToken = overrides.token
  return new Store(overrides.chunkLength ?? CHUNK_LENGTH, options)
}

function put(
  store: ChunkStore,
  index: number,
  data: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    store.put(index, data, error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function get(
  store: ChunkStore,
  index: number,
  options: { length?: number; offset?: number } = {}
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    store.get(index, options, (error, data) => {
      if (error || !data) reject(error ?? new Error('missing chunk'))
      else resolve(data)
    })
  })
}

function close(store: ChunkStore): Promise<void> {
  return new Promise((resolve, reject) => {
    store.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-guarded-store-'))
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('GuardedStoreSupervisor', () => {
  it('rejects a grant whose paths escape the authorized root', () => {
    expect(
      () =>
        new GuardedStoreSupervisor(grantFor([{ length: 4, path: '../out' }]))
    ).toThrow(GuardedStoreError)
    expect(
      () =>
        new GuardedStoreSupervisor(grantFor([{ length: 4, path: '/etc/x' }]))
    ).toThrow(GuardedStoreError)
    expect(
      () =>
        new GuardedStoreSupervisor(grantFor([{ length: 4, path: 'a/../../b' }]))
    ).toThrow(GuardedStoreError)
  })

  it('performs no filesystem action while constructing the store', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 12, path: 'nested/deep/file.bin' }])
    )
    createStore(supervisor)

    expect(await exists(path.join(root, 'nested'))).toBe(false)
    expect(supervisor.faults).toEqual([])
  })

  it('writes and reads chunks that span a file boundary', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([
        { length: 5, path: 'one.bin' },
        { length: 7, path: 'nested/two.bin' }
      ])
    )
    const store = createStore(supervisor)

    await put(store, 0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
    await put(store, 1, Uint8Array.from([9, 10, 11, 12]))

    expect([...(await get(store, 0))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...(await get(store, 1))]).toEqual([9, 10, 11, 12])
    expect([...(await get(store, 0, { length: 3, offset: 4 }))]).toEqual([
      5, 6, 7
    ])

    await close(store)
    expect([...(await readFile(path.join(root, 'one.bin')))]).toEqual([
      1, 2, 3, 4, 5
    ])
    expect([...(await readFile(path.join(root, 'nested', 'two.bin')))]).toEqual(
      [6, 7, 8, 9, 10, 11, 12]
    )
  })

  it('never creates a directory for a read of an absent file', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 8, path: 'absent/deselected.bin' }])
    )
    const store = createStore(supervisor)

    await expect(get(store, 0)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await exists(path.join(root, 'absent'))).toBe(false)
  })

  it('fails closed when a parent component is a symlink', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wu-guarded-outside-'))
    try {
      const sentinel = path.join(outside, 'sentinel.bin')
      await writeFile(sentinel, 'untouched')
      await symlink(outside, path.join(root, 'nested'), 'dir')

      const supervisor = new GuardedStoreSupervisor(
        grantFor([{ length: 8, path: 'nested/payload.bin' }])
      )
      const store = createStore(supervisor)

      await expect(
        put(store, 0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(get(store, 0)).rejects.toMatchObject({
        code: 'ACCESS_DENIED'
      })

      expect(await exists(path.join(outside, 'payload.bin'))).toBe(false)
      expect(await readFile(sentinel, 'utf8')).toBe('untouched')
    } finally {
      await rm(outside, { force: true, recursive: true })
    }
  })

  it('refuses to follow a symlinked payload file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wu-guarded-target-'))
    try {
      const target = path.join(outside, 'target.bin')
      await writeFile(target, 'untouched')
      await symlink(target, path.join(root, 'payload.bin'))

      const supervisor = new GuardedStoreSupervisor(
        grantFor([{ length: 8, path: 'payload.bin' }])
      )
      const store = createStore(supervisor)

      await expect(
        put(store, 0, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
      ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect(await readFile(target, 'utf8')).toBe('untouched')
    } finally {
      await rm(outside, { force: true, recursive: true })
    }
  })

  it('records a mutated grant token instead of throwing from the constructor', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 8, path: 'payload.bin' }])
    )
    const store = createStore(supervisor, { token: Symbol('forged') })

    expect(supervisor.faults).toEqual([
      { code: 'GRANT_MISMATCH', detail: expect.any(String) as string }
    ])
    await expect(get(store, 0)).rejects.toMatchObject({
      code: 'STORE_FAULTED'
    })
    expect(await exists(path.join(root, 'payload.bin'))).toBe(false)
  })

  it('records mismatched geometry and a second store instance', () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 8, path: 'payload.bin' }])
    )
    createStore(supervisor, { chunkLength: 16 })
    createStore(supervisor)

    expect(supervisor.faults.map(fault => fault.code)).toEqual([
      'GEOMETRY_MISMATCH',
      'MULTIPLE_INSTANCES'
    ])
  })

  it('creates a selected zero-length file only after the commit barrier', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([
        { length: 0, path: 'selected-empty.bin' },
        { length: 0, path: 'deselected-empty.bin' },
        { length: 4, path: 'payload.bin' }
      ])
    )
    createStore(supervisor)

    expect(await exists(path.join(root, 'selected-empty.bin'))).toBe(false)

    await supervisor.materializeSelected([0])
    expect(await exists(path.join(root, 'selected-empty.bin'))).toBe(true)
    expect(await exists(path.join(root, 'deselected-empty.bin'))).toBe(false)
  })

  it('closes handles without deleting payload and rejects later operations', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 4, path: 'payload.bin' }])
    )
    const store = createStore(supervisor)
    await put(store, 0, Uint8Array.from([1, 2, 3, 4]))

    await new Promise<void>((resolve, reject) => {
      store.destroy(error => (error ? reject(error) : resolve()))
    })
    await close(store)

    expect(await readFile(path.join(root, 'payload.bin'))).toHaveLength(4)
    await expect(get(store, 0)).rejects.toMatchObject({ code: 'STORE_CLOSED' })
  })

  it('rejects chunk ranges outside the manifest geometry', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 8, path: 'payload.bin' }])
    )
    const store = createStore(supervisor)

    await expect(get(store, 4)).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })
    await expect(get(store, 0, { length: 32 })).rejects.toMatchObject({
      code: 'OUT_OF_RANGE'
    })
    await expect(
      put(store, 0, Uint8Array.from([1, 2, 3]))
    ).rejects.toMatchObject({ code: 'OUT_OF_RANGE' })
  })

  it('creates missing intermediate directories once for a write', async () => {
    const supervisor = new GuardedStoreSupervisor(
      grantFor([{ length: 4, path: 'a/b/c/payload.bin' }])
    )
    const store = createStore(supervisor)
    await mkdir(path.join(root, 'a'), { recursive: true })

    await put(store, 0, Uint8Array.from([1, 2, 3, 4]))
    expect(await exists(path.join(root, 'a', 'b', 'c', 'payload.bin'))).toBe(
      true
    )
    await close(store)
  })
})
