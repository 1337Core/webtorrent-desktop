import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  engineChildMessageSchema,
  engineParentMessageSchema,
  PROTOCOL_VERSION,
  type EngineParentMessage,
  type EngineStatus
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'

const electronMock = vi.hoisted(() => ({
  fork: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: electronMock.fork
  }
}))

import { EngineSupervisor } from './engine-supervisor'

class FakeUtilityProcess extends EventEmitter {
  readonly messages: unknown[] = []
  readonly kill = vi.fn(() => true)

  readonly postMessage = vi.fn((message: unknown): void => {
    this.messages.push(message)
  })
}

function createHarness(): {
  children: FakeUtilityProcess[]
  diagnostics: Diagnostics
  statuses: EngineStatus[]
  supervisor: EngineSupervisor
} {
  const children: FakeUtilityProcess[] = []
  electronMock.fork.mockImplementation(() => {
    const child = new FakeUtilityProcess()
    children.push(child)
    return child
  })
  const statuses: EngineStatus[] = []
  const diagnostics = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
  const supervisor = new EngineSupervisor({
    appVersion: '1.0.0-dev',
    diagnostics,
    entryPath: '/app/engine/index.mjs',
    getStateRevision: () => 7,
    onStatus: status => statuses.push(status),
    workingDirectory: '/app/engine-data'
  })
  return { children, diagnostics, statuses, supervisor }
}

function spawnAndInitialize(
  supervisor: EngineSupervisor,
  children: FakeUtilityProcess[]
): {
  child: FakeUtilityProcess
  initialize: Extract<EngineParentMessage, { type: 'engine:initialize' }>
} {
  supervisor.start()
  const child = children.at(-1)
  if (!child) throw new Error('Expected a utility process')
  child.emit('spawn')
  const initialize = engineParentMessageSchema.parse(child.messages.at(-1))
  if (initialize.type !== 'engine:initialize') {
    throw new Error('Expected an initialize message')
  }
  return { child, initialize }
}

function emitReady(
  child: FakeUtilityProcess,
  initialize: Extract<EngineParentMessage, { type: 'engine:initialize' }>
): void {
  child.emit(
    'message',
    engineChildMessageSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      generationId: initialize.generationId,
      requestId: initialize.requestId,
      sequence: 0,
      timestampMs: Date.now(),
      type: 'engine:ready',
      payload: {
        architecture: 'arm64',
        electronVersion: '43.2.0',
        nodeVersion: '24.18.0',
        processType: 'utility',
        utpEnabled: false,
        webRtcSupported: true,
        webTorrentVersion: '3.0.16'
      }
    })
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-24T12:00:00Z'))
  electronMock.fork.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('EngineSupervisor', () => {
  it('spawns with a minimal environment and reaches ready', () => {
    const { children, statuses, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)

    expect(initialize.payload).toEqual({
      appVersion: '1.0.0-dev',
      stateRevision: 7,
      stateSchemaVersion: 1
    })
    expect(electronMock.fork).toHaveBeenCalledWith(
      '/app/engine/index.mjs',
      [],
      expect.objectContaining({
        cwd: '/app/engine-data',
        env: expect.not.objectContaining({
          GITHUB_TOKEN: expect.anything(),
          HTTPS_PROXY: expect.anything()
        }),
        execArgv: [],
        stdio: 'ignore'
      })
    )

    emitReady(child, initialize)
    expect(supervisor.status()).toMatchObject({
      state: 'ready',
      generationId: initialize.generationId,
      webRtcSupported: true
    })
    expect(statuses.at(-1)?.state).toBe('ready')
  })

  it('restarts once after any unexpected exit, including code zero', async () => {
    const { children, supervisor } = createHarness()
    const first = spawnAndInitialize(supervisor, children)
    emitReady(first.child, first.initialize)

    first.child.emit('exit', 0)
    expect(supervisor.status()).toMatchObject({
      state: 'restarting',
      restartCount: 1
    })

    await vi.advanceTimersByTimeAsync(500)
    const second = children.at(-1)
    if (!second || second === first.child) {
      throw new Error('Expected a replacement utility process')
    }
    second.emit('spawn')
    const secondInitialize = engineParentMessageSchema.parse(
      second.messages.at(-1)
    )
    if (secondInitialize.type !== 'engine:initialize') {
      throw new Error('Expected a replacement initialize message')
    }
    emitReady(second, secondInitialize)
    second.emit('exit', 1)

    expect(supervisor.status()).toEqual({
      state: 'stopped',
      code: 'ENGINE_CRASH_LOOP',
      message: 'Torrent engine stopped after repeated unexpected exits.'
    })
  })

  it('stops immediately on a malformed child protocol message', () => {
    const { children, supervisor } = createHarness()
    const { child } = spawnAndInitialize(supervisor, children)

    child.emit('message', { arbitrary: true })

    expect(child.kill).toHaveBeenCalledOnce()
    expect(supervisor.status()).toEqual({
      state: 'stopped',
      code: 'ENGINE_PROTOCOL_ERROR',
      message: 'Torrent engine sent an invalid protocol message.'
    })
  })

  it('waits for the child exit after requesting graceful shutdown', async () => {
    const { children, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)
    emitReady(child, initialize)

    let stopped = false
    const stopPromise = supervisor.stop().then(result => {
      stopped = true
      return result
    })
    await Promise.resolve()

    expect(stopped).toBe(false)
    expect(engineParentMessageSchema.parse(child.messages.at(-1)).type).toBe(
      'engine:shutdown'
    )

    child.emit('exit', 0)
    await expect(stopPromise).resolves.toEqual({
      outcome: 'exited',
      forced: false
    })
    expect(stopped).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('forces shutdown when posting races with child teardown', async () => {
    const { children, diagnostics, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)
    emitReady(child, initialize)
    child.postMessage.mockImplementationOnce(() => {
      throw new Error('process already closing')
    })

    const stopPromise = supervisor.stop()

    expect(child.kill).toHaveBeenCalledOnce()
    expect(diagnostics.error).toHaveBeenCalledWith(
      'engine.shutdown-message-failed'
    )
    child.emit('exit', 0)
    await expect(stopPromise).resolves.toEqual({
      outcome: 'exited',
      forced: true
    })
  })

  it('reports a forced shutdown timeout when no exit is observed', async () => {
    const { children, diagnostics, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)
    emitReady(child, initialize)
    child.kill.mockReturnValue(false)

    const stopPromise = supervisor.stop()
    let settled = false
    void stopPromise.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(diagnostics.error).toHaveBeenCalledWith('engine.kill-failed', {
      reason: 'SHUTDOWN'
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(stopPromise).resolves.toEqual({
      outcome: 'timed-out',
      killAccepted: false
    })
    expect(diagnostics.error).toHaveBeenCalledWith(
      'engine.shutdown-exit-timeout'
    )
  })

  it('contains a heartbeat postMessage race and restarts after exit', async () => {
    const { children, diagnostics, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)
    emitReady(child, initialize)
    child.postMessage.mockImplementationOnce(() => {
      throw new Error('process already exited')
    })

    await vi.advanceTimersByTimeAsync(15_000)

    expect(diagnostics.error).toHaveBeenCalledWith(
      'engine.heartbeat-message-failed'
    )
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 1)
    expect(supervisor.status()).toMatchObject({
      state: 'restarting',
      reasonCode: 'FATAL_ERROR'
    })
  })

  it('kills and restarts a process that misses startup', async () => {
    const { children, supervisor } = createHarness()
    const { child } = spawnAndInitialize(supervisor, children)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 1)
    expect(supervisor.status()).toMatchObject({
      state: 'restarting',
      reasonCode: 'STARTUP_TIMEOUT'
    })
  })

  it('kills and restarts a ready process that misses a heartbeat', async () => {
    const { children, supervisor } = createHarness()
    const { child, initialize } = spawnAndInitialize(supervisor, children)
    emitReady(child, initialize)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(engineParentMessageSchema.parse(child.messages.at(-1)).type).toBe(
      'engine:ping'
    )
    await vi.advanceTimersByTimeAsync(3_000)
    expect(child.kill).toHaveBeenCalledOnce()

    child.emit('exit', 1)
    expect(supervisor.status()).toMatchObject({
      state: 'restarting',
      reasonCode: 'HEARTBEAT_TIMEOUT'
    })
  })

  it('enters a visible stopped state when the utility cannot spawn', () => {
    const { supervisor } = createHarness()
    electronMock.fork.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })

    supervisor.start()

    expect(supervisor.status()).toEqual({
      state: 'stopped',
      code: 'ENGINE_START_FAILED',
      message: 'Torrent engine could not be started.'
    })
  })
})
