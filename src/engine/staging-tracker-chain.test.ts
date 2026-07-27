import { describe, expect, it } from 'vitest'
import {
  StagingTrackerChain,
  type StagingTrackerAttempt
} from './staging-tracker-chain'

type ControlledAttempt = StagingTrackerAttempt &
  Readonly<{
    activate: () => void
    fail: () => void
    finishStop: () => void
  }>

function controlled(endpoint: string, events: string[]): ControlledAttempt {
  let activate = (): void => undefined
  let fail = (): void => undefined
  let finishStop = (): void => undefined
  const activated = new Promise<void>(resolve => {
    activate = resolve
  })
  const failed = new Promise<void>(resolve => {
    fail = resolve
  })
  const stopped = new Promise<void>(resolve => {
    finishStop = resolve
  })
  return {
    activate,
    activated,
    fail,
    failed,
    finishStop,
    freeze: () => events.push(`freeze:${endpoint}`),
    start: () => events.push(`start:${endpoint}`),
    stop: async () => {
      events.push(`stop:${endpoint}`)
      await stopped
      events.push(`stopped:${endpoint}`)
    }
  }
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('StagingTrackerChain', () => {
  for (const endpoints of [
    ['https://one.example/announce', 'wss://two.example/announce'],
    ['wss://one.example/announce', 'https://two.example/announce']
  ]) {
    it(`preserves mixed protocol order: ${endpoints[0]?.slice(0, 5)} first`, async () => {
      const events: string[] = []
      const attempts: ControlledAttempt[] = []
      const chain = new StagingTrackerChain({
        createAttempt: endpoint => {
          const attempt = controlled(endpoint, events)
          attempts.push(attempt)
          return attempt
        },
        endpoints
      })
      chain.start()
      await tick()
      expect(attempts).toHaveLength(1)

      attempts[0]?.fail()
      await tick()
      expect(attempts).toHaveLength(1)
      expect(events).toContain(`stop:${endpoints[0]}`)

      attempts[0]?.finishStop()
      await tick()
      expect(attempts).toHaveLength(2)
      expect(events.indexOf(`stopped:${endpoints[0]}`)).toBeLessThan(
        events.indexOf(`start:${endpoints[1]}`)
      )

      attempts[1]?.activate()
      await expect(chain.ready).resolves.toBeUndefined()
      const stopping = chain.stop()
      attempts[1]?.finishStop()
      await stopping
    })
  }

  it('freezes and fully tears down the active endpoint without failover', async () => {
    const events: string[] = []
    const attempts: ControlledAttempt[] = []
    const chain = new StagingTrackerChain({
      createAttempt: endpoint => {
        const attempt = controlled(endpoint, events)
        attempts.push(attempt)
        return attempt
      },
      endpoints: ['https://one.example', 'wss://two.example']
    })
    chain.start()
    await tick()
    attempts[0]?.activate()
    await chain.ready

    const stopping = chain.stop()
    await tick()
    expect(attempts).toHaveLength(1)
    attempts[0]?.finishStop()
    await stopping
    expect(events).not.toContain('start:wss://two.example')
  })
})
