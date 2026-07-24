import { describe, expect, it, vi } from 'vitest'
import {
  EngineOperationAbortedError,
  EngineOperationQueue,
  EngineQueueClosedError
} from './operation-queue'

describe('EngineOperationQueue', () => {
  it('serializes one torrent while allowing unrelated torrents to proceed', async () => {
    const queue = new EngineOperationQueue()
    const release = Promise.withResolvers<void>()
    const order: string[] = []

    const first = queue.run('a', async () => {
      order.push('a:start')
      await release.promise
      order.push('a:end')
    })
    const second = queue.run('a', () => {
      order.push('a:second')
    })
    const unrelated = queue.run('b', () => {
      order.push('b')
    })

    await unrelated
    expect(order).toEqual(['a:start', 'b'])
    release.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['a:start', 'b', 'a:end', 'a:second'])
  })

  it('contains a failed operation without poisoning the next one', async () => {
    const queue = new EngineOperationQueue()
    const first = queue.run('a', () => {
      throw new Error('expected failure')
    })
    const next = queue.run('a', () => 'recovered')

    await expect(first).rejects.toThrow('expected failure')
    await expect(next).resolves.toBe('recovered')
  })

  it('does not start queued work after its caller deadline is aborted', async () => {
    const queue = new EngineOperationQueue()
    const release = Promise.withResolvers<void>()
    const first = queue.run('a', () => release.promise)
    const controller = new AbortController()
    const queued = queue.run('a', () => 'must not run', controller.signal)

    controller.abort()
    release.resolve()

    await expect(first).resolves.toBeUndefined()
    await expect(queued).rejects.toBeInstanceOf(EngineOperationAbortedError)
  })

  it('stops admission, aborts running work, and drains every admitted promise', async () => {
    const queue = new EngineOperationQueue()
    const observedAbort = vi.fn()
    const started = Promise.withResolvers<void>()
    const running = queue.run('a', async signal => {
      started.resolve()
      await new Promise<void>(resolve => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort()
            resolve()
          },
          { once: true }
        )
      })
    })
    await started.promise
    const queued = queue.run('a', () => 'must not run')

    queue.close()
    await queue.drain()

    await expect(running).resolves.toBeUndefined()
    await expect(queued).rejects.toBeInstanceOf(EngineQueueClosedError)
    await expect(queue.run('b', () => undefined)).rejects.toBeInstanceOf(
      EngineQueueClosedError
    )
    expect(observedAbort).toHaveBeenCalledOnce()
    expect(queue.pendingCount).toBe(0)
  })
})
