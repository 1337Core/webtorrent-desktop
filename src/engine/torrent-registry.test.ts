import { describe, expect, it } from 'vitest'
import {
  TorrentRegistry,
  TorrentRegistryError,
  TORRENT_REGISTRY_LIMITS
} from './torrent-registry'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const OTHER_INFO_HASH = 'fedcba9876543210fedcba9876543210fedcba98'

function hashForIndex(index: number): string {
  return index.toString(16).padStart(40, '0')
}

function createRegistry(): TorrentRegistry {
  let counter = 0
  return new TorrentRegistry({
    createGenerationId: () => {
      counter += 1
      return `generation-${counter}`
    }
  })
}

describe('TorrentRegistry', () => {
  it('rejects malformed input before any state changes', () => {
    const registry = createRegistry()

    expect(() =>
      registry.reserve({ fileCount: 1, infoHash: 'nope', owner: 'public' })
    ).toThrow(TorrentRegistryError)
    expect(() =>
      registry.reserve({
        fileCount: -1,
        infoHash: INFO_HASH,
        owner: 'public'
      })
    ).toThrow(TorrentRegistryError)
    expect(registry.size).toBe(0)
  })

  it('reserves an info hash exclusively across every client', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 3,
      infoHash: INFO_HASH,
      owner: 'public'
    })

    expect(reservation.generationId).toBe('generation-1')
    expect(registry.has(INFO_HASH)).toBe(true)
    expect(registry.fileEntryCount).toBe(3)
    expect(() =>
      registry.reserve({ fileCount: 1, infoHash: INFO_HASH, owner: 'private' })
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_INFO_HASH' }) as Error)
    expect(() =>
      registry.reserve({ fileCount: 1, infoHash: INFO_HASH, owner: 'staging' })
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_INFO_HASH' }) as Error)
  })

  it('admits peers only for a committed generation', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 1,
      infoHash: INFO_HASH,
      owner: 'public'
    })

    expect(registry.admits(INFO_HASH)).toBe(false)

    const entry = registry.commit(reservation)
    expect(entry.state).toBe('committed')
    expect(registry.admits(INFO_HASH)).toBe(true)
    expect(registry.admits(INFO_HASH, reservation.generationId)).toBe(true)
    expect(registry.admits(INFO_HASH, 'generation-stale')).toBe(false)

    registry.beginTeardown(INFO_HASH)
    expect(registry.admits(INFO_HASH)).toBe(false)
  })

  it('keeps the hash unavailable until the destroy callback releases it', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 2,
      infoHash: INFO_HASH,
      owner: 'private'
    })
    registry.commit(reservation)
    registry.beginTeardown(INFO_HASH)

    expect(registry.has(INFO_HASH)).toBe(true)
    expect(() =>
      registry.reserve({ fileCount: 2, infoHash: INFO_HASH, owner: 'private' })
    ).toThrow(expect.objectContaining({ code: 'DUPLICATE_INFO_HASH' }) as Error)

    expect(registry.release(INFO_HASH)).toBe(true)
    expect(registry.release(INFO_HASH)).toBe(false)
    expect(registry.has(INFO_HASH)).toBe(false)
    expect(registry.fileEntryCount).toBe(0)
    expect(() =>
      registry.reserve({ fileCount: 2, infoHash: INFO_HASH, owner: 'public' })
    ).not.toThrow()
  })

  it('rolls a pre-metadata failure back without a tombstone', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 5,
      infoHash: INFO_HASH,
      owner: 'public'
    })

    registry.rollback(reservation)
    expect(registry.has(INFO_HASH)).toBe(false)
    expect(registry.fileEntryCount).toBe(0)
    expect(() => registry.rollback(reservation)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }) as Error
    )
  })

  it('refuses a stale token and a repeated commit', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 1,
      infoHash: INFO_HASH,
      owner: 'public'
    })
    registry.commit(reservation)

    expect(() => registry.commit(reservation)).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
    expect(() =>
      registry.commit({ ...reservation, token: Symbol('forged') })
    ).toThrow(expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error)
    expect(() => registry.rollback(reservation)).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
  })

  it('refuses to tear down or release out of order', () => {
    const registry = createRegistry()
    const reservation = registry.reserve({
      fileCount: 1,
      infoHash: INFO_HASH,
      owner: 'public'
    })

    expect(() => registry.beginTeardown(INFO_HASH)).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
    registry.commit(reservation)
    expect(() => registry.release(INFO_HASH)).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }) as Error
    )
    expect(() => registry.beginTeardown(OTHER_INFO_HASH)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }) as Error
    )
  })

  it('bounds loaded torrents and aggregate file entries', () => {
    const registry = createRegistry()
    for (
      let index = 0;
      index < TORRENT_REGISTRY_LIMITS.loadedTorrents;
      index += 1
    ) {
      registry.reserve({
        fileCount: 1,
        infoHash: hashForIndex(index),
        owner: 'public'
      })
    }

    expect(registry.size).toBe(TORRENT_REGISTRY_LIMITS.loadedTorrents)
    expect(() =>
      registry.reserve({ fileCount: 1, infoHash: INFO_HASH, owner: 'public' })
    ).toThrow(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }) as Error)

    const spacious = createRegistry()
    spacious.reserve({
      fileCount: TORRENT_REGISTRY_LIMITS.aggregateFileEntries - 1,
      infoHash: INFO_HASH,
      owner: 'public'
    })
    expect(() =>
      spacious.reserve({
        fileCount: 2,
        infoHash: OTHER_INFO_HASH,
        owner: 'private'
      })
    ).toThrow(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }) as Error)
  })

  it('reports ownership and tombstones everything on shutdown', () => {
    const registry = createRegistry()
    const first = registry.reserve({
      fileCount: 1,
      infoHash: INFO_HASH,
      owner: 'public'
    })
    const second = registry.reserve({
      fileCount: 1,
      infoHash: OTHER_INFO_HASH,
      owner: 'private'
    })
    registry.commit(first)
    registry.commit(second)

    expect(
      registry.listByOwner('private').map(entry => entry.infoHash)
    ).toEqual([OTHER_INFO_HASH])
    expect(registry.get(INFO_HASH)?.owner).toBe('public')
    expect(registry.get('not-a-hash')).toBeNull()

    expect(registry.closeAll()).toHaveLength(2)
    expect(registry.admits(INFO_HASH)).toBe(false)
    expect(registry.admits(OTHER_INFO_HASH)).toBe(false)
    expect(registry.release(INFO_HASH)).toBe(true)
    expect(registry.release(OTHER_INFO_HASH)).toBe(true)
    expect(registry.size).toBe(0)
  })
})
