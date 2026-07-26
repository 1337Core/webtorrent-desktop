import { describe, expect, it } from 'vitest'
import {
  bootstrapRequestSchema,
  bootstrapResultSchema,
  ENGINE_MESSAGE_BUDGET,
  engineChildMessageSchema,
  engineParentMessageSchema,
  engineStatusEventSchema,
  isEngineStatus,
  PROTOCOL_VERSION,
  restartEngineRequestSchema,
  restartEngineResultSchema
} from './contracts'
import { checkPayloadBudget } from './payload-budget'

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const generationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const engineRuntime = {
  architecture: 'arm64',
  audioMetadataParser: 'music-metadata.parseStream',
  mediaPort: 52_000,
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
            preferences: {
              downloadRoot: null,
              externalPlayer: null,
              openAtLogin: false,
              torrentsFolder: null
            }
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

  it('validates initialize, ping, execute, and shutdown parent messages', () => {
    expect(
      engineParentMessageSchema.safeParse({
        ...base,
        type: 'engine:execute',
        payload: {
          deadlineMs: 10_000,
          operation: {
            command: 'list-torrents',
            payload: { cursor: 0, limit: 50 }
          }
        }
      }).success
    ).toBe(true)
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

  it('validates correlated results and independently identified events', () => {
    for (const message of [
      { ...base, type: 'engine:ready', payload: engineRuntime },
      { ...base, type: 'engine:pong', payload: {} },
      {
        ...base,
        type: 'engine:result',
        payload: {
          ok: true,
          result: {
            command: 'list-torrents',
            value: { items: [], nextCursor: null, total: 0 }
          }
        }
      },
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
    const eventBase = {
      protocolVersion: base.protocolVersion,
      generationId: base.generationId,
      sequence: base.sequence,
      timestampMs: base.timestampMs
    }
    expect(
      engineChildMessageSchema.safeParse({
        ...eventBase,
        type: 'engine:event',
        eventId: requestId,
        payload: {
          event: 'torrent-removed',
          payload: {
            infoHash: '0123456789abcdef0123456789abcdef01234567'
          }
        }
      }).success
    ).toBe(true)
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

  it('keeps boundary-size command envelopes inside the transport budget', () => {
    const envelopes = [
      {
        ...base,
        type: 'engine:execute',
        payload: {
          deadlineMs: 10_000,
          operation: {
            command: 'open-preparation',
            payload: {
              source: {
                kind: 'magnet',
                magnet: `magnet:?dn=${'x'.repeat(65_525)}`,
                allowDhtExposure: false,
                allowPrivateNetwork: false
              }
            }
          }
        }
      },
      {
        ...base,
        type: 'engine:execute',
        payload: {
          deadlineMs: 10_000,
          operation: {
            command: 'update-preparation-selection',
            payload: {
              preparationId: requestId,
              changes: Array.from({ length: 250 }, (_, index) => ({
                index,
                selected: true
              }))
            }
          }
        }
      }
    ]

    for (const envelope of envelopes) {
      const parsed = engineParentMessageSchema.parse(envelope)
      expect(checkPayloadBudget(parsed, ENGINE_MESSAGE_BUDGET)).toMatchObject({
        ok: true
      })
    }

    const maximumTorrentPage = Array.from({ length: 64 }, (_, index) => ({
      infoHash: index.toString(16).padStart(40, '0'),
      name: 'n'.repeat(255),
      length: 1,
      fileCount: 1,
      selectedFileCount: 1,
      private: false,
      state: 'downloading',
      progress: 1,
      downloaded: 1,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      peerCount: 0,
      timeRemainingMs: 0
    }))
    const childEnvelope = engineChildMessageSchema.parse({
      ...base,
      type: 'engine:result',
      payload: {
        ok: true,
        result: {
          command: 'list-torrents',
          value: {
            items: maximumTorrentPage,
            nextCursor: null,
            total: maximumTorrentPage.length
          }
        }
      }
    })
    expect(
      checkPayloadBudget(childEnvelope, ENGINE_MESSAGE_BUDGET)
    ).toMatchObject({ ok: true })
  })
})
