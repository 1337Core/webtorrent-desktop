import { describe, expect, it } from 'vitest'
import {
  bootstrapRequestSchema,
  bootstrapResultSchema,
  engineChildMessageSchema,
  engineParentMessageSchema,
  engineStatusEventSchema,
  isEngineStatus,
  PROTOCOL_VERSION,
  restartEngineRequestSchema,
  restartEngineResultSchema
} from './contracts'

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const engineRuntime = {
  architecture: 'arm64',
  electronVersion: '43.2.0',
  nodeVersion: '24.18.0',
  processType: 'utility',
  utpEnabled: false,
  webRtcSupported: true,
  webTorrentVersion: '3.0.16'
} as const

const readyStatus = {
  state: 'ready',
  generationId,
  restartCount: 0,
  ...engineRuntime
} as const

describe('engine status contracts', () => {
  it('accepts every supported engine state', () => {
    expect(
      isEngineStatus({
        state: 'starting',
        generationId: null,
        restartCount: 0
      })
    ).toBe(true)
    expect(isEngineStatus(readyStatus)).toBe(true)
    expect(
      isEngineStatus({
        state: 'restarting',
        generationId,
        restartCount: 1,
        reasonCode: 'CRASHED'
      })
    ).toBe(true)
    expect(
      isEngineStatus({
        state: 'stopped',
        code: 'ENGINE_CRASH_LOOP',
        message: 'Torrent engine stopped.'
      })
    ).toBe(true)
  })

  it.each([
    null,
    { state: 'starting' },
    { ...readyStatus, unknown: true },
    { ...readyStatus, restartCount: 2 },
    { state: 'failed', message: 'legacy state' },
    { state: 'unknown' }
  ])('rejects malformed status %#', value => {
    expect(isEngineStatus(value)).toBe(false)
  })

  it('requires a versioned, sequenced event envelope', () => {
    const event = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: requestId,
      sequence: 4,
      status: readyStatus
    }
    expect(engineStatusEventSchema.safeParse(event).success).toBe(true)
    expect(
      engineStatusEventSchema.safeParse({
        ...event,
        protocolVersion: 2
      }).success
    ).toBe(false)
    expect(
      engineStatusEventSchema.safeParse({ ...event, sequence: -1 }).success
    ).toBe(false)
  })
})

describe('renderer IPC contracts', () => {
  it('accepts only the two named, strictly bounded requests', () => {
    expect(
      bootstrapRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command: 'bootstrap',
        payload: {
          preloadTrustProof: {
            contextIsolated: true,
            isMainFrame: true,
            sandboxed: true
          }
        }
      }).success
    ).toBe(true)
    expect(
      restartEngineRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command: 'restartEngine',
        payload: {}
      }).success
    ).toBe(true)
    expect(
      bootstrapRequestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command: 'bootstrap',
        payload: {
          preloadTrustProof: {
            contextIsolated: true,
            isMainFrame: true,
            sandboxed: true
          },
          arbitrary: true
        }
      }).success
    ).toBe(false)
  })

  it('validates bootstrap success and fixed error results', () => {
    const event = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: requestId,
      sequence: 0,
      status: readyStatus
    }
    expect(
      bootstrapResultSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          engineStatusEvent: event,
          state: {
            schemaVersion: 1,
            revision: 0,
            preferences: {}
          },
          runtime: {
            appName: 'WebTorrent Updated',
            appVersion: '1.0.0-dev',
            architecture: 'arm64',
            chromeVersion: '142.0.7444.175',
            electronVersion: '43.2.0',
            nodeVersion: '24.18.0',
            platform: 'darwin'
          }
        }
      }).success
    ).toBe(true)

    const error = {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        retryable: false,
        displayMessage: 'The application rejected the request.'
      }
    }
    expect(bootstrapResultSchema.safeParse(error).success).toBe(true)
    expect(restartEngineResultSchema.safeParse(error).success).toBe(true)
    expect(
      bootstrapResultSchema.safeParse({
        ...error,
        error: { ...error.error, stack: 'not allowed' }
      }).success
    ).toBe(false)
  })
})

describe('engine control contracts', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    generationId,
    requestId,
    sequence: 0,
    timestampMs: 1
  }

  it('validates initialize, ping, and shutdown parent messages', () => {
    expect(
      engineParentMessageSchema.safeParse({
        ...base,
        type: 'engine:initialize',
        payload: {
          appVersion: '1.0.0-dev',
          stateRevision: 0,
          stateSchemaVersion: 1
        }
      }).success
    ).toBe(true)
    expect(
      engineParentMessageSchema.safeParse({
        ...base,
        type: 'engine:ping',
        payload: {}
      }).success
    ).toBe(true)
    expect(
      engineParentMessageSchema.safeParse({
        ...base,
        type: 'engine:shutdown',
        payload: { reason: 'APP_QUIT' }
      }).success
    ).toBe(true)
  })

  it('validates ready, pong, stopped, and fixed failure child messages', () => {
    for (const message of [
      { ...base, type: 'engine:ready', payload: engineRuntime },
      { ...base, type: 'engine:pong', payload: {} },
      { ...base, type: 'engine:stopped', payload: {} },
      {
        ...base,
        type: 'engine:failed',
        payload: {
          code: 'START_FAILED',
          message: 'Torrent engine failed its startup capability check.'
        }
      }
    ]) {
      expect(engineChildMessageSchema.safeParse(message).success).toBe(true)
    }
    expect(
      engineChildMessageSchema.safeParse({
        ...base,
        type: 'engine:failed',
        payload: {
          code: 'START_FAILED',
          message: 'x'.repeat(257)
        }
      }).success
    ).toBe(false)
  })
})
