import { z } from 'zod'
import {
  engineCommandResultSchema,
  engineCommandSchema,
  engineEventSchema
} from './engine-api'

export * from './engine-api'

export const APP_NAME = 'WebTorrent Updated'
export const PROTOCOL_VERSION = 1 as const
export const DESKTOP_BOOTSTRAP_CHANNEL = 'desktop:bootstrap:v1'
export const DESKTOP_ENGINE_RESTART_CHANNEL = 'desktop:engine-restart:v1'
export const ENGINE_STATUS_CHANNEL = 'desktop:engine-status:v1'
export const ENGINE_MESSAGE_BUDGET = {
  maxBytes: 128 * 1024,
  maxDepth: 16,
  maxNodes: 1024
} as const

const protocolVersionSchema = z.literal(PROTOCOL_VERSION)
const requestIdSchema = z.string().uuid()
const generationIdSchema = z.string().uuid()
const sequenceSchema = z.number().int().nonnegative().safe()
const timestampSchema = z.number().int().nonnegative().safe()
const boundedMessageSchema = z.string().min(1).max(256)

const windowBoundsSchema = z.strictObject({
  x: z.number().int().min(-100_000).max(100_000),
  y: z.number().int().min(-100_000).max(100_000),
  width: z.number().int().min(760).max(16_384),
  height: z.number().int().min(560).max(16_384)
})

const preferencesSchema = z.strictObject({})

/**
 * One durable library row. Large per-torrent data (selection, resume
 * bitfield, torrent bytes) lives in fork-owned files, so this record stays
 * small enough for the bounded state document.
 */
const torrentRecordSchema = z.strictObject({
  addedAtMs: timestampSchema,
  destinationRoot: z.string().min(1).max(4_096),
  infoHash: z.string().regex(/^[0-9a-f]{40}$/u),
  name: z.string().min(1).max(255),
  paused: z.boolean(),
  private: z.boolean()
})

export type TorrentRecord = z.infer<typeof torrentRecordSchema>

const librarySchema = z
  .strictObject({
    torrents: z.array(torrentRecordSchema).max(64)
  })
  .refine(
    value =>
      new Set(value.torrents.map(torrent => torrent.infoHash)).size ===
      value.torrents.length,
    'A library holds one record per info hash.'
  )

export const appStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  library: librarySchema,
  preferences: preferencesSchema,
  window: z.strictObject({
    main: z.strictObject({
      normalBounds: windowBoundsSchema.nullable()
    })
  })
})

export type AppState = z.infer<typeof appStateSchema>

export const DEFAULT_APP_STATE: AppState = {
  schemaVersion: 1,
  revision: 0,
  library: { torrents: [] },
  preferences: {},
  window: {
    main: {
      normalBounds: null
    }
  }
}

export const runtimeInfoSchema = z.strictObject({
  appName: z.literal(APP_NAME),
  appVersion: z.string().min(1).max(64),
  architecture: z.literal('arm64'),
  chromeVersion: z.string().min(1).max(64),
  electronVersion: z.literal('43.2.0'),
  nodeVersion: z.literal('24.18.0'),
  platform: z.literal('darwin')
})

export type RuntimeInfo = z.infer<typeof runtimeInfoSchema>

const engineRuntimeInfoSchema = z.strictObject({
  architecture: z.literal('arm64'),
  electronVersion: z.literal('43.2.0'),
  nodeVersion: z.literal('24.18.0'),
  processType: z.literal('utility'),
  utpEnabled: z.literal(false),
  webRtcSupported: z.literal(true),
  webTorrentVersion: z.literal('3.0.16')
})

export type EngineRuntimeInfo = z.infer<typeof engineRuntimeInfoSchema>

export const engineStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('starting'),
    generationId: generationIdSchema.nullable(),
    restartCount: z.number().int().min(0).max(1)
  }),
  z
    .strictObject({
      state: z.literal('ready'),
      generationId: generationIdSchema,
      restartCount: z.number().int().min(0).max(1)
    })
    .extend(engineRuntimeInfoSchema.shape),
  z.strictObject({
    state: z.literal('restarting'),
    generationId: generationIdSchema,
    restartCount: z.literal(1),
    reasonCode: z.enum([
      'CRASHED',
      'FATAL_ERROR',
      'HEARTBEAT_TIMEOUT',
      'STARTUP_TIMEOUT'
    ])
  }),
  z.strictObject({
    state: z.literal('stopped'),
    code: z.enum([
      'ENGINE_CRASH_LOOP',
      'ENGINE_PROTOCOL_ERROR',
      'ENGINE_START_FAILED'
    ]),
    message: boundedMessageSchema
  })
])

export type EngineStatus = z.infer<typeof engineStatusSchema>

export const engineStatusEventSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  eventId: requestIdSchema,
  sequence: sequenceSchema,
  status: engineStatusSchema
})

export type EngineStatusEvent = z.infer<typeof engineStatusEventSchema>

const engineParentBaseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  generationId: generationIdSchema,
  requestId: requestIdSchema,
  sequence: sequenceSchema,
  timestampMs: timestampSchema
})

export const engineParentMessageSchema = z.discriminatedUnion('type', [
  engineParentBaseSchema.extend({
    type: z.literal('engine:initialize'),
    payload: z.strictObject({
      appVersion: z.string().min(1).max(64),
      stateRevision: z.number().int().nonnegative(),
      stateSchemaVersion: z.literal(1)
    })
  }),
  engineParentBaseSchema.extend({
    type: z.literal('engine:ping'),
    payload: z.strictObject({})
  }),
  engineParentBaseSchema.extend({
    type: z.literal('engine:execute'),
    payload: z.strictObject({
      deadlineMs: timestampSchema,
      operation: engineCommandSchema
    })
  }),
  engineParentBaseSchema.extend({
    type: z.literal('engine:shutdown'),
    payload: z.strictObject({
      reason: z.enum(['APP_QUIT', 'SUPERVISOR_RESTART'])
    })
  })
])

export type EngineParentMessage = z.infer<typeof engineParentMessageSchema>

const engineChildBaseSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  generationId: generationIdSchema,
  sequence: sequenceSchema,
  timestampMs: timestampSchema
})

export const engineChildMessageSchema = z.discriminatedUnion('type', [
  engineChildBaseSchema.extend({
    type: z.literal('engine:ready'),
    requestId: requestIdSchema,
    payload: engineRuntimeInfoSchema
  }),
  engineChildBaseSchema.extend({
    type: z.literal('engine:pong'),
    requestId: requestIdSchema,
    payload: z.strictObject({})
  }),
  engineChildBaseSchema.extend({
    type: z.literal('engine:result'),
    requestId: requestIdSchema,
    payload: engineCommandResultSchema
  }),
  engineChildBaseSchema.extend({
    type: z.literal('engine:event'),
    eventId: requestIdSchema,
    causeRequestId: requestIdSchema.optional(),
    payload: engineEventSchema
  }),
  engineChildBaseSchema.extend({
    type: z.literal('engine:stopped'),
    requestId: requestIdSchema,
    payload: z.strictObject({})
  }),
  engineChildBaseSchema.extend({
    type: z.literal('engine:failed'),
    requestId: requestIdSchema,
    payload: z.strictObject({
      code: z.enum([
        'INVALID_MESSAGE',
        'NATIVE_WEBRTC_UNAVAILABLE',
        'RUNTIME_MISMATCH',
        'START_FAILED'
      ]),
      message: boundedMessageSchema
    })
  })
])

export type EngineChildMessage = z.infer<typeof engineChildMessageSchema>
export type EngineEventEnvelope = Extract<
  EngineChildMessage,
  { type: 'engine:event' }
>

export const restartEngineRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  requestId: requestIdSchema,
  command: z.literal('restartEngine'),
  payload: z.strictObject({})
})

export const preloadTrustProofSchema = z.strictObject({
  contextIsolated: z.literal(true),
  isMainFrame: z.literal(true),
  sandboxed: z.literal(true)
})

export type PreloadTrustProof = z.infer<typeof preloadTrustProofSchema>

export const bootstrapRequestSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  requestId: requestIdSchema,
  command: z.literal('bootstrap'),
  payload: z.strictObject({
    preloadTrustProof: preloadTrustProofSchema
  })
})

const bootstrapSnapshotSchema = z.strictObject({
  protocolVersion: protocolVersionSchema,
  engineStatusEvent: engineStatusEventSchema,
  state: z.strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    preferences: preferencesSchema
  }),
  runtime: runtimeInfoSchema
})

export type BootstrapSnapshot = z.infer<typeof bootstrapSnapshotSchema>

const desktopErrorSchema = z.strictObject({
  code: z.enum([
    'DUPLICATE_REQUEST',
    'ENGINE_UNAVAILABLE',
    'INTERNAL',
    'INVALID_REQUEST',
    'INVALID_STATE',
    'PAYLOAD_TOO_LARGE',
    'PROTOCOL_MISMATCH',
    'REQUEST_TIMEOUT',
    'UNAUTHORIZED_SENDER'
  ]),
  retryable: z.boolean(),
  displayMessage: boundedMessageSchema,
  diagnosticId: requestIdSchema.optional()
})

export const bootstrapResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    requestId: requestIdSchema,
    ok: z.literal(true),
    value: bootstrapSnapshotSchema
  }),
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    requestId: requestIdSchema.nullable(),
    ok: z.literal(false),
    error: desktopErrorSchema
  })
])

export type BootstrapResult = z.infer<typeof bootstrapResultSchema>

export const restartEngineResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    requestId: requestIdSchema,
    ok: z.literal(true),
    value: z.strictObject({
      accepted: z.literal(true),
      status: engineStatusSchema
    })
  }),
  z.strictObject({
    protocolVersion: protocolVersionSchema,
    requestId: requestIdSchema.nullable(),
    ok: z.literal(false),
    error: desktopErrorSchema
  })
])

export type RestartEngineResult = z.infer<typeof restartEngineResultSchema>

export function isEngineStatus(value: unknown): value is EngineStatus {
  return engineStatusSchema.safeParse(value).success
}
