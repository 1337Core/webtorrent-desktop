import { describe, expect, it, vi } from 'vitest'
import {
  PRIVATE_CHAIN_LIMITS,
  PrivateTrackerChain,
  type PrivateChainMember
} from './private-tracker-chain'

type Record = {
  completed: number
  started: boolean
  stopped: boolean
  url: string
}

/**
 * A chain over recording members. Each member reports failure only when the
 * test asks it to, so ordering is decided by the chain rather than by timing.
 */
function harness(
  endpoints: ReadonlyArray<string>,
  options: Readonly<{ backoffMs?: number }> = {}
): {
  chain: PrivateTrackerChain
  fail: (url: string) => void
  live: () => ReadonlyArray<string>
  records: Record[]
} {
  const records: Record[] = []
  const failures = new Map<string, () => void>()
  const chain = new PrivateTrackerChain({
    backoffMs: () => options.backoffMs ?? 60_000,
    createMember: ({ onFailed, url }): PrivateChainMember => {
      const record: Record = {
        completed: 0,
        started: false,
        stopped: false,
        url
      }
      records.push(record)
      failures.set(url, onFailed)
      return {
        notifyCompleted: () => {
          record.completed += 1
        },
        start: () => {
          record.started = true
        },
        stop: () => {
          record.stopped = true
          return Promise.resolve()
        }
      }
    },
    endpoints
  })

  return {
    chain,
    fail: url => {
      const onFailed = failures.get(url)
      if (!onFailed) throw new Error(`No live member for ${url}`)
      onFailed()
    },
    live: () =>
      records.filter(entry => entry.started && !entry.stopped).map(e => e.url),
    records
  }
}

const HTTPS = 'https://tracker.invalid/announce'
const WSS = 'wss://tracker.invalid/announce'
const SECOND_HTTPS = 'https://backup.invalid/announce'

describe('PrivateTrackerChain', () => {
  it('keeps exactly one endpoint in contact across transports', async () => {
    const { chain, fail, live } = harness([HTTPS, WSS, SECOND_HTTPS])

    await chain.start()
    // The whole point: an HTTPS and a WSS endpoint of the same private torrent
    // are one sequence, not two lists that run beside each other.
    expect(live()).toEqual([HTTPS])

    fail(HTTPS)
    await vi.waitFor(() => expect(live()).toEqual([WSS]))

    fail(WSS)
    await vi.waitFor(() => expect(live()).toEqual([SECOND_HTTPS]))

    await chain.stop()
    expect(live()).toEqual([])
  })

  it('retires the failing endpoint before building the next one', async () => {
    const order: string[] = []
    const chain = new PrivateTrackerChain({
      backoffMs: () => 60_000,
      createMember: ({ onFailed, url }) => {
        order.push(`create:${url}`)
        if (url === HTTPS) queueMicrotask(onFailed)
        return {
          start: () => {
            order.push(`start:${url}`)
          },
          stop: () => {
            order.push(`stop:${url}`)
            return Promise.resolve()
          }
        }
      },
      endpoints: [HTTPS, WSS]
    })

    await chain.start()
    await vi.waitFor(() =>
      expect(order).toContain('start:wss://tracker.invalid/announce')
    )

    // The retiring endpoint's peers and sockets are gone before the
    // replacement exists, which is what bounds the exposure to one tracker.
    expect(order).toEqual([
      `create:${HTTPS}`,
      `start:${HTTPS}`,
      `stop:${HTTPS}`,
      `create:${WSS}`,
      `start:${WSS}`
    ])
    await chain.stop()
  })

  it('waits out a backoff before retrying an exhausted sequence', async () => {
    vi.useFakeTimers()
    try {
      const { chain, fail, live, records } = harness([HTTPS], {
        backoffMs: 60_000
      })

      await chain.start()
      fail(HTTPS)
      await vi.advanceTimersByTimeAsync(0)

      // A torrent whose only tracker is down keeps retrying that tracker and
      // never widens its exposure to reach someone else.
      expect(live()).toEqual([])
      await vi.advanceTimersByTimeAsync(59_000)
      expect(records).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(live()).toEqual([HTTPS])
      await chain.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports completion only to the endpoint currently in contact', async () => {
    const { chain, fail, records } = harness([HTTPS, WSS])

    await chain.start()
    chain.notifyCompleted()
    fail(HTTPS)
    await vi.waitFor(() => expect(records).toHaveLength(2))
    chain.notifyCompleted()

    expect(records[0]?.completed).toBe(1)
    expect(records[1]?.completed).toBe(1)
    await chain.stop()
  })

  it('advances once however often a member reports the same failure', async () => {
    const { chain, fail, records } = harness([HTTPS, WSS, SECOND_HTTPS])

    await chain.start()
    fail(HTTPS)
    fail(HTTPS)
    fail(HTTPS)
    await vi.waitFor(() => expect(records).toHaveLength(2))

    expect(records.map(entry => entry.url)).toEqual([HTTPS, WSS])
    await chain.stop()
  })

  it('bounds how many endpoints one torrent can put in the chain', async () => {
    const declared = Array.from(
      { length: PRIVATE_CHAIN_LIMITS.maxEndpoints + 8 },
      (_unused, index) => `https://tracker-${index}.invalid/announce`
    )
    const { chain } = harness(declared)

    expect(chain.endpointCount).toBe(PRIVATE_CHAIN_LIMITS.maxEndpoints)
    await chain.stop()
  })

  it('starts nothing when the torrent declares no endpoint', async () => {
    const { chain, records } = harness([])

    await chain.start()

    expect(records).toEqual([])
    expect(chain.activeUrl).toBeNull()
    await chain.stop()
  })
})
