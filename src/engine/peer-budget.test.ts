import { describe, expect, it } from 'vitest'
import { PEER_BUDGET_LIMITS, PeerBudget } from './peer-budget'

function budget(
  live = 0,
  stagingLive = 0
): { budget: PeerBudget; setLive: (value: number) => void } {
  let current = live
  return {
    budget: new PeerBudget({
      liveTransports: () => current,
      stagingLiveTransports: () => stagingLive
    }),
    setLive: value => {
      current = value
    }
  }
}

function fill(target: PeerBudget, key: string, count: number): number {
  let admitted = 0
  for (let index = 0; index < count; index += 1) {
    if (
      target.admit({ key, peer: `203.0.113.${index % 250}:${6_000 + index}` })
    ) {
      admitted += 1
    }
  }
  return admitted
}

describe('PeerBudget', () => {
  it('admits a peer once and repeats it without new capacity', () => {
    const { budget: target } = budget()

    expect(target.admit({ key: 'a', peer: '203.0.113.1:6881' })).toBe(true)
    expect(target.admit({ key: 'a', peer: '203.0.113.1:6881' })).toBe(true)
    expect(target.recordCount).toBe(1)
  })

  it('bounds the records one torrent may retain', () => {
    const { budget: target } = budget()

    const admitted = fill(target, 'a', 200)

    expect(admitted).toBe(PEER_BUDGET_LIMITS.maxRecordsPerTorrent)
    expect(target.recordsFor('a')).toBe(PEER_BUDGET_LIMITS.maxRecordsPerTorrent)
  })

  it('refuses every peer once the engine holds its live transports', () => {
    const { budget: target, setLive } = budget()
    expect(target.admit({ key: 'a', peer: '203.0.113.1:6881' })).toBe(true)

    setLive(PEER_BUDGET_LIMITS.maxLiveTransports)

    expect(target.admit({ key: 'a', peer: '203.0.113.2:6881' })).toBe(false)
    expect(target.admit({ key: 'b', peer: '203.0.113.3:6881' })).toBe(false)
    // A transport that WebTorrent drops returns its capacity with no
    // bookkeeping of its own.
    setLive(PEER_BUDGET_LIMITS.maxLiveTransports - 1)
    expect(target.admit({ key: 'b', peer: '203.0.113.3:6881' })).toBe(true)
  })

  it('shares engine-wide capacity instead of starving a quiet torrent', () => {
    const { budget: target } = budget()
    fill(target, 'busy', PEER_BUDGET_LIMITS.maxRecordsPerTorrent)
    fill(target, 'second', PEER_BUDGET_LIMITS.maxRecordsPerTorrent)
    expect(target.recordCount).toBe(PEER_BUDGET_LIMITS.maxRecords)

    // The engine is full, and the quiet torrent still gets in.
    expect(target.admit({ key: 'quiet', peer: '198.51.100.9:6881' })).toBe(true)
    expect(target.recordsFor('quiet')).toBe(1)
    expect(target.recordCount).toBe(PEER_BUDGET_LIMITS.maxRecords)
    expect(target.recordsFor('busy')).toBe(
      PEER_BUDGET_LIMITS.maxRecordsPerTorrent - 1
    )
  })

  it('never funds one holder’s growth from its own records', () => {
    const { budget: target } = budget()
    fill(target, 'busy', PEER_BUDGET_LIMITS.maxRecordsPerTorrent)
    fill(target, 'second', PEER_BUDGET_LIMITS.maxRecordsPerTorrent)

    // 'second' is at its own per-torrent cap and the engine is full.
    expect(target.admit({ key: 'second', peer: '198.51.100.1:6881' })).toBe(
      false
    )
    expect(target.recordCount).toBe(PEER_BUDGET_LIMITS.maxRecords)
  })

  it('bounds staging acquisitions inside the shared budget', () => {
    const { budget: target } = budget()

    let admitted = 0
    for (let index = 0; index < 40; index += 1) {
      if (
        target.admit({
          key: 'staging',
          peer: `203.0.113.${index}:6881`,
          scope: 'staging'
        })
      ) {
        admitted += 1
      }
    }

    expect(admitted).toBe(PEER_BUDGET_LIMITS.maxStagingRecordsPerAcquisition)
  })

  it('refuses staging peers once staging holds its transports', () => {
    const { budget: target } = budget(
      0,
      PEER_BUDGET_LIMITS.maxStagingLiveTransports
    )

    expect(
      target.admit({
        key: 'staging',
        peer: '203.0.113.1:6881',
        scope: 'staging'
      })
    ).toBe(false)
    // The narrower staging limit never blocks an ordinary torrent.
    expect(target.admit({ key: 'a', peer: '203.0.113.1:6881' })).toBe(true)
  })

  it('holds PEX discovery to its own narrower ceiling', () => {
    const { budget: target } = budget()

    let admitted = 0
    for (let index = 0; index < 120; index += 1) {
      if (
        target.admit({
          key: 'a',
          peer: `203.0.113.${index % 250}:${7_000 + index}`,
          scope: 'pex'
        })
      ) {
        admitted += 1
      }
    }

    expect(admitted).toBe(PEER_BUDGET_LIMITS.maxPexRecordsPerTorrent)
    expect(target.pexRecordsFor('a')).toBe(
      PEER_BUDGET_LIMITS.maxPexRecordsPerTorrent
    )
    // The same torrent still has ordinary record capacity left.
    expect(target.admit({ key: 'a', peer: '198.51.100.1:6881' })).toBe(true)
  })

  it('bounds PEX discovery engine-wide, not only per torrent', () => {
    const { budget: target } = budget()

    let admitted = 0
    for (let torrent = 0; torrent < 4; torrent += 1) {
      for (let index = 0; index < 40; index += 1) {
        if (
          target.admit({
            key: `torrent-${torrent}`,
            peer: `203.0.113.${index}:${8_000 + index}`,
            scope: 'pex'
          })
        ) {
          admitted += 1
        }
      }
    }

    expect(admitted).toBe(PEER_BUDGET_LIMITS.maxPexRecords)
  })

  it('returns capacity when a torrent or a peer goes away', () => {
    const { budget: target } = budget()
    fill(target, 'a', 10)
    expect(target.recordsFor('a')).toBe(10)

    target.forget('a', '203.0.113.0:6000')
    expect(target.recordsFor('a')).toBe(9)

    target.release('a')
    expect(target.recordsFor('a')).toBe(0)
    expect(target.recordCount).toBe(0)
  })
})
