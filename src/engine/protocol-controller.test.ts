import { describe, expect, it, vi } from 'vitest'
import {
  engineChildMessageSchema,
  PROTOCOL_VERSION,
  type EngineChildMessage,
  type EngineCommand,
  type EngineCommandResult,
  type EngineParentMessage,
  type EngineRuntimeInfo
} from '../shared/contracts'
import { EngineProtocolController } from './protocol-controller'

const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const runtime: EngineRuntimeInfo = {
  architecture: 'arm64',
  audioMetadataParser: 'music-metadata.parseStream',
  mediaPort: 52_000,
  electronVersion: '43.2.0',
  nodeVersion: '24.18.0',
  processType: 'utility',
  utpEnabled: false,
  webRtcSupported: true,
  webTorrentVersion: '3.0.16'
}

function requestId(sequence: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-${sequence.toString().padStart(12, '0')}`
}

function parentMessage(
  sequence: number,
  message: Pick<EngineParentMessage, 'type' | 'payload'>,
  id = requestId(sequence)
): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    generationId,
    requestId: id,
    sequence,
    timestampMs: Date.now(),
    ...message
  }
}

function successfulListResult(): EngineCommandResult {
  return {
    ok: true,
    result: {
      command: 'list-torrents',
      value: {
        items: [],
        nextCursor: null,
        total: 0
      }
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
}

async function initialize(
  controller: EngineProtocolController,
  posted: EngineChildMessage[]
): Promise<void> {
  controller.receive(
    parentMessage(0, {
      type: 'engine:initialize',
      payload: {
        appVersion: '1.0.0-dev',
        stateRevision: 0,
        stateSchemaVersion: 1
      }
    })
  )
  await flushMicrotasks()
  expect(posted.at(-1)?.type).toBe('engine:ready')
}

describe('EngineProtocolController', () => {
  it('answers a heartbeat while a lifecycle operation is still running', async () => {
    const posted: EngineChildMessage[] = []
    const operation = Promise.withResolvers<EngineCommandResult>()
    const controller = new EngineProtocolController({
      execute: () => operation.promise,
      exit: vi.fn(),
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime)
    })
    await initialize(controller, posted)

    controller.receive(
      parentMessage(1, {
        type: 'engine:execute',
        payload: {
          deadlineMs: Date.now() + 10_000,
          operation: {
            command: 'list-torrents',
            payload: { cursor: 0, limit: 50 }
          }
        }
      })
    )
    controller.receive(
      parentMessage(2, {
        type: 'engine:ping',
        payload: {}
      })
    )

    expect(posted.at(-1)?.type).toBe('engine:pong')
    operation.resolve(successfulListResult())
    await flushMicrotasks()
    expect(posted.at(-1)?.type).toBe('engine:result')
  })

  it('times out work even when an executor ignores its abort signal', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-24T12:00:00Z'))
    try {
      const posted: EngineChildMessage[] = []
      const exit = vi.fn()
      const operation = Promise.withResolvers<EngineCommandResult>()
      const execute = vi.fn(() =>
        execute.mock.calls.length === 1
          ? operation.promise
          : Promise.resolve(successfulListResult())
      )
      const controller = new EngineProtocolController({
        execute,
        exit,
        postMessage: message => posted.push(message),
        proveRuntime: () => Promise.resolve(runtime)
      })
      await initialize(controller, posted)

      controller.receive(
        parentMessage(1, {
          type: 'engine:execute',
          payload: {
            deadlineMs: Date.now() + 100,
            operation: {
              command: 'list-torrents',
              payload: { cursor: 0, limit: 50 }
            }
          }
        })
      )
      await vi.advanceTimersByTimeAsync(100)

      expect(posted.at(-1)).toMatchObject({
        type: 'engine:result',
        payload: {
          ok: false,
          error: {
            command: 'list-torrents',
            code: 'TIMEOUT'
          }
        }
      })

      controller.receive(
        parentMessage(2, {
          type: 'engine:execute',
          payload: {
            deadlineMs: Date.now() + 1_000,
            operation: {
              command: 'list-torrents',
              payload: { cursor: 0, limit: 50 }
            }
          }
        })
      )
      await flushMicrotasks()
      expect(execute).toHaveBeenCalledOnce()

      operation.resolve(successfulListResult())
      await flushMicrotasks()
      expect(execute).toHaveBeenCalledTimes(2)
      expect(posted.at(-1)).toMatchObject({
        type: 'engine:result',
        requestId: requestId(2),
        payload: { ok: true }
      })

      controller.receive(
        parentMessage(3, {
          type: 'engine:shutdown',
          payload: { reason: 'APP_QUIT' }
        })
      )
      await flushMicrotasks()
      expect(posted.at(-1)?.type).toBe('engine:stopped')
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts admitted work before completing shutdown', async () => {
    const posted: EngineChildMessage[] = []
    const exit = vi.fn()
    const shutdown = vi.fn(() => Promise.resolve())
    const controller = new EngineProtocolController({
      execute: (_operation, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true
          })
        }),
      exit,
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime),
      shutdown
    })
    await initialize(controller, posted)
    controller.receive(
      parentMessage(1, {
        type: 'engine:execute',
        payload: {
          deadlineMs: Date.now() + 10_000,
          operation: {
            command: 'list-torrents',
            payload: { cursor: 0, limit: 50 }
          }
        }
      })
    )
    controller.receive(
      parentMessage(2, {
        type: 'engine:shutdown',
        payload: { reason: 'APP_QUIT' }
      })
    )
    await flushMicrotasks()

    expect(posted.at(-1)?.type).toBe('engine:stopped')
    expect(
      posted.filter(message => message.type === 'engine:result')
    ).toHaveLength(0)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('waits for runtime resources before acknowledging shutdown', async () => {
    const posted: EngineChildMessage[] = []
    const exit = vi.fn()
    const shutdown = Promise.withResolvers<void>()
    const controller = new EngineProtocolController({
      execute: () => Promise.resolve(successfulListResult()),
      exit,
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime),
      shutdown: () => shutdown.promise
    })
    await initialize(controller, posted)

    controller.receive(
      parentMessage(1, {
        type: 'engine:shutdown',
        payload: { reason: 'APP_QUIT' }
      })
    )
    await flushMicrotasks()

    expect(posted.some(message => message.type === 'engine:stopped')).toBe(
      false
    )
    expect(exit).not.toHaveBeenCalled()

    shutdown.resolve()
    await flushMicrotasks()

    expect(posted.at(-1)?.type).toBe('engine:stopped')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('fails closed when runtime shutdown rejects', async () => {
    const posted: EngineChildMessage[] = []
    const exit = vi.fn()
    const controller = new EngineProtocolController({
      execute: () => Promise.resolve(successfulListResult()),
      exit,
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime),
      shutdown: () => Promise.reject(new Error('close failed'))
    })
    await initialize(controller, posted)

    controller.receive(
      parentMessage(1, {
        type: 'engine:shutdown',
        payload: { reason: 'APP_QUIT' }
      })
    )
    await flushMicrotasks()

    expect(posted.some(message => message.type === 'engine:stopped')).toBe(
      false
    )
    expect(exit).toHaveBeenCalledWith(2)
  })

  it('rejects a reused request ID before executing a mutation twice', async () => {
    const posted: EngineChildMessage[] = []
    const exit = vi.fn()
    const execute = vi.fn(
      (_operation: EngineCommand): Promise<EngineCommandResult> =>
        Promise.resolve(successfulListResult())
    )
    const controller = new EngineProtocolController({
      execute,
      exit,
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime)
    })
    await initialize(controller, posted)
    const duplicateId = requestId(99)

    controller.receive(
      parentMessage(
        1,
        {
          type: 'engine:execute',
          payload: {
            deadlineMs: Date.now() + 10_000,
            operation: {
              command: 'list-torrents',
              payload: { cursor: 0, limit: 50 }
            }
          }
        },
        duplicateId
      )
    )
    await flushMicrotasks()
    controller.receive(
      parentMessage(
        2,
        {
          type: 'engine:execute',
          payload: {
            deadlineMs: Date.now() + 10_000,
            operation: {
              command: 'list-torrents',
              payload: { cursor: 0, limit: 50 }
            }
          }
        },
        duplicateId
      )
    )

    expect(execute).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(2)
  })

  it('emits events with an independent event ID', async () => {
    const posted: EngineChildMessage[] = []
    const controller = new EngineProtocolController({
      execute: () => Promise.resolve(successfulListResult()),
      exit: vi.fn(),
      postMessage: message => posted.push(message),
      proveRuntime: () => Promise.resolve(runtime)
    })
    await initialize(controller, posted)

    expect(
      controller.emit({
        event: 'torrent-removed',
        payload: {
          infoHash: '0123456789abcdef0123456789abcdef01234567'
        }
      })
    ).toBe(true)
    const event = engineChildMessageSchema.parse(posted.at(-1))
    expect(event.type).toBe('engine:event')
    if (event.type !== 'engine:event') throw new Error('Expected event')
    expect(event.eventId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
    )
    expect('requestId' in event).toBe(false)
  })
})
