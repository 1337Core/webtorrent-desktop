import { z } from 'zod'

const utf8Encoder = new TextEncoder()
const uuidSchema = z.string().uuid()
const infoHashSchema = z.string().regex(/^[a-f\d]{40}$/u)
const hasAtMostUtf8Bytes =
  (maximumBytes: number) =>
  (value: string): boolean =>
    utf8Encoder.encode(value).byteLength <= maximumBytes
const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every(character => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127
  })
const boundedNameSchema = z
  .string()
  .min(1)
  .refine(hasAtMostUtf8Bytes(255))
  .refine(hasNoControlCharacters)
const boundedMessageSchema = z.string().min(1).refine(hasAtMostUtf8Bytes(512))
const boundedPathSchema = z
  .string()
  .min(1)
  .refine(hasAtMostUtf8Bytes(4_096))
  .refine(hasNoControlCharacters)
const relativePathSchema = boundedPathSchema
  .refine(value => !value.startsWith('/') && !value.startsWith('\\'))
  .refine(value => !value.includes('\\'))
  .refine(
    value =>
      !value
        .split('/')
        .some(segment => segment === '' || segment === '.' || segment === '..')
  )
const absolutePathSchema = boundedPathSchema
  .refine(
    value =>
      value.startsWith('/') &&
      value !== '/' &&
      !value.startsWith('//') &&
      !value.endsWith('/')
  )
  .refine(
    value =>
      !value
        .split('/')
        .some(
          (segment, index) =>
            index > 0 && (segment === '' || segment === '.' || segment === '..')
        )
  )
const magnetSchema = z
  .string()
  .min(1)
  .refine(hasAtMostUtf8Bytes(65_536))
  .refine(value => value.startsWith('magnet:?'))
const endpointSchema = z.string().min(1).refine(hasAtMostUtf8Bytes(2_048))
function usesProtocol(value: string, protocol: string): boolean {
  try {
    return new URL(value).protocol === protocol
  } catch {
    return false
  }
}
const remoteTorrentEndpointSchema = endpointSchema.refine(value => {
  try {
    const endpoint = new URL(value)
    return (
      ['http:', 'https:'].includes(endpoint.protocol) &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.hash === ''
    )
  } catch {
    return false
  }
})
const trackerEndpointSchema = endpointSchema.refine(value => {
  try {
    const endpoint = new URL(value)
    return (
      ['http:', 'https:', 'wss:'].includes(endpoint.protocol) &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.hash === ''
    )
  } catch {
    return false
  }
})
const pageRequestSchema = z.strictObject({
  cursor: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(64).default(50)
})

const engineCommandNameSchema = z.enum([
  'close-media',
  'commit-preparation',
  'create-torrent',
  'discard-preparation',
  'get-preparation-files',
  'get-torrent-files',
  'heartbeat-media',
  'import-legacy-torrent',
  'list-legacy-imports',
  'list-torrents',
  'open-media',
  'open-preparation',
  'open-subtitles',
  'pause-torrent',
  'remove-torrent',
  'restore-torrent',
  'resume-torrent',
  'set-torrent-selection',
  'update-preparation-selection'
])

const localTorrentSourceSchema = z.strictObject({
  kind: z.literal('local-torrent'),
  path: absolutePathSchema
})

const remoteTorrentSourceSchema = z
  .strictObject({
    kind: z.literal('remote-torrent'),
    url: remoteTorrentEndpointSchema,
    allowHttp: z.boolean(),
    allowPrivateNetwork: z.boolean()
  })
  .refine(value => value.allowHttp || !usesProtocol(value.url, 'http:'))

const magnetSourceSchema = z.strictObject({
  kind: z.literal('magnet'),
  magnet: magnetSchema,
  allowDhtExposure: z.boolean(),
  allowPrivateNetwork: z.boolean()
})

const infoHashSourceSchema = z.strictObject({
  kind: z.literal('info-hash'),
  infoHash: infoHashSchema,
  allowDhtExposure: z.boolean(),
  allowPrivateNetwork: z.boolean()
})

const trackerTiersSchema = z
  .array(z.array(trackerEndpointSchema).min(1).max(64))
  .max(64)
  .refine(tiers => tiers.reduce((count, tier) => count + tier.length, 0) <= 64)
  .refine(
    tiers =>
      tiers.reduce(
        (bytes, tier) =>
          bytes +
          tier.reduce(
            (tierBytes, endpoint) =>
              tierBytes + utf8Encoder.encode(endpoint).byteLength,
            0
          ),
        0
      ) <= 32_768
  )
  .refine(tiers => {
    const endpoints = tiers.flat()
    return new Set(endpoints).size === endpoints.length
  })

export const engineCommandSchema = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('open-preparation'),
    payload: z.strictObject({
      source: z.discriminatedUnion('kind', [
        localTorrentSourceSchema,
        remoteTorrentSourceSchema,
        magnetSourceSchema,
        infoHashSourceSchema
      ])
    })
  }),
  z.strictObject({
    command: z.literal('get-preparation-files'),
    payload: pageRequestSchema.extend({
      preparationId: uuidSchema
    })
  }),
  z.strictObject({
    command: z.literal('update-preparation-selection'),
    payload: z
      .strictObject({
        preparationId: uuidSchema,
        changes: z
          .array(
            z.strictObject({
              index: z.number().int().min(0).max(99_999),
              selected: z.boolean()
            })
          )
          .min(1)
          .max(250)
      })
      .refine(
        value =>
          new Set(value.changes.map(change => change.index)).size ===
          value.changes.length
      )
  }),
  z.strictObject({
    command: z.literal('commit-preparation'),
    payload: z.strictObject({
      preparationId: uuidSchema,
      destinationRoot: absolutePathSchema
    })
  }),
  z.strictObject({
    command: z.literal('discard-preparation'),
    payload: z.strictObject({
      preparationId: uuidSchema
    })
  }),
  /**
   * Rebuilds one session from the archived torrent bytes at startup. Main
   * holds the identity, destination, and status intent; the engine revalidates
   * the bytes through the ordinary metadata boundary and takes the selection
   * from the torrent's own resume sidecar.
   */
  z.strictObject({
    command: z.literal('restore-torrent'),
    payload: z.strictObject({
      infoHash: infoHashSchema,
      destinationRoot: absolutePathSchema,
      paused: z.boolean()
    })
  }),
  z.strictObject({
    command: z.literal('list-torrents'),
    payload: pageRequestSchema
  }),
  z.strictObject({
    command: z.literal('list-legacy-imports'),
    payload: pageRequestSchema.extend({
      legacyRoot: absolutePathSchema
    })
  }),
  z.strictObject({
    command: z.literal('import-legacy-torrent'),
    payload: z.strictObject({
      destinationRoot: absolutePathSchema,
      infoHash: infoHashSchema,
      legacyRoot: absolutePathSchema
    })
  }),
  z.strictObject({
    command: z.literal('get-torrent-files'),
    payload: pageRequestSchema.extend({
      infoHash: infoHashSchema
    })
  }),
  z.strictObject({
    command: z.literal('set-torrent-selection'),
    payload: z
      .strictObject({
        infoHash: infoHashSchema,
        changes: z
          .array(
            z.strictObject({
              index: z.number().int().min(0).max(99_999),
              selected: z.boolean()
            })
          )
          .min(1)
          .max(250)
      })
      .refine(
        value =>
          new Set(value.changes.map(change => change.index)).size ===
          value.changes.length
      )
  }),
  z.strictObject({
    command: z.literal('pause-torrent'),
    payload: z.strictObject({
      infoHash: infoHashSchema
    })
  }),
  z.strictObject({
    command: z.literal('resume-torrent'),
    payload: z.strictObject({
      infoHash: infoHashSchema
    })
  }),
  z.strictObject({
    command: z.literal('remove-torrent'),
    payload: z.strictObject({
      infoHash: infoHashSchema,
      deleteData: z.literal(false)
    })
  }),
  z.strictObject({
    command: z.literal('create-torrent'),
    payload: z
      .strictObject({
        operationId: uuidSchema,
        sourcePath: absolutePathSchema,
        destinationRoot: absolutePathSchema,
        name: boundedNameSchema.optional(),
        comment: z.string().refine(hasAtMostUtf8Bytes(4_096)).optional(),
        private: z.boolean(),
        announceTiers: trackerTiersSchema,
        allowHttpTrackers: z.boolean(),
        allowPrivateNetwork: z.boolean(),
        filterJunkFiles: z.boolean()
      })
      .refine(
        value => !value.private || value.announceTiers.flat().length > 0,
        'Private torrents require at least one tracker.'
      )
      .refine(
        value =>
          value.allowHttpTrackers ||
          value.announceTiers
            .flat()
            .every(endpoint => !usesProtocol(endpoint, 'http:')),
        'HTTP trackers require explicit consent.'
      )
  }),
  z.strictObject({
    command: z.literal('open-media'),
    payload: z.strictObject({
      infoHash: infoHashSchema,
      fileIndex: z.number().int().min(0).max(99_999)
    })
  }),
  /**
   * Offers the torrent's own completed subtitle files as WebVTT tracks the
   * player can attach. Each track is served by the same loopback proxy under
   * its own opaque token, so no subtitle text crosses the command boundary.
   */
  z.strictObject({
    command: z.literal('open-subtitles'),
    payload: z.strictObject({
      infoHash: infoHashSchema
    })
  }),
  z.strictObject({
    command: z.literal('heartbeat-media'),
    payload: z.strictObject({
      leaseId: uuidSchema
    })
  }),
  z.strictObject({
    command: z.literal('close-media'),
    payload: z.strictObject({
      leaseId: uuidSchema
    })
  })
])

export type EngineCommand = z.infer<typeof engineCommandSchema>

export const torrentSummarySchema = z
  .strictObject({
    infoHash: infoHashSchema,
    name: boundedNameSchema,
    length: z.number().int().nonnegative().safe(),
    fileCount: z.number().int().min(1).max(100_000),
    selectedFileCount: z.number().int().min(0).max(100_000),
    private: z.boolean(),
    state: z.enum([
      'checking',
      'downloading',
      'error',
      'paused',
      'seeding',
      'stopped'
    ]),
    progress: z.number().min(0).max(1),
    downloaded: z.number().int().nonnegative().safe(),
    uploaded: z.number().int().nonnegative().safe(),
    downloadSpeed: z.number().nonnegative().finite(),
    uploadSpeed: z.number().nonnegative().finite(),
    peerCount: z.number().int().nonnegative().max(10_000),
    timeRemainingMs: z.number().int().nonnegative().safe().nullable()
  })
  .refine(value => value.selectedFileCount <= value.fileCount)
  .refine(value => value.downloaded <= value.length)

const torrentFileSummarySchema = z
  .strictObject({
    index: z.number().int().min(0).max(99_999),
    path: relativePathSchema,
    length: z.number().int().nonnegative().safe(),
    selected: z.boolean(),
    downloaded: z.number().int().nonnegative().safe(),
    progress: z.number().min(0).max(1)
  })
  .refine(value => value.downloaded <= value.length)

const torrentSummaryPageSchema = z
  .array(torrentSummarySchema)
  .max(64)
  .refine(
    items =>
      items.reduce(
        (bytes, item) => bytes + utf8Encoder.encode(item.name).byteLength,
        0
      ) <= 16_384
  )
  .refine(items =>
    items.every(
      (item, index) =>
        index === 0 ||
        items[index - 1]!.infoHash.localeCompare(item.infoHash) < 0
    )
  )

const torrentFileSummaryPageSchema = z
  .array(torrentFileSummarySchema)
  .max(64)
  .refine(
    items =>
      items.reduce(
        (bytes, item) => bytes + utf8Encoder.encode(item.path).byteLength,
        0
      ) <= 40_960
  )
  .refine(items =>
    items.every(
      (item, index) => index === 0 || items[index - 1]!.index < item.index
    )
  )

const legacyImportEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('importable'),
    infoHash: infoHashSchema,
    name: boundedNameSchema,
    length: z.number().int().nonnegative().safe(),
    fileCount: z.number().int().min(1).max(100_000),
    selectedFileCount: z.number().int().min(0).max(100_000),
    private: z.boolean()
  }),
  z.strictObject({
    kind: z.literal('skipped'),
    name: boundedNameSchema,
    reason: z.enum([
      'DUPLICATE',
      'INVALID_ENTRY',
      'INVALID_METADATA',
      'PRIVATE_WITHOUT_TRACKER',
      'TORRENT_FILE_MISSING',
      'UNSUPPORTED_FORMAT'
    ])
  })
])

const legacyImportPageSchema = z
  .array(legacyImportEntrySchema)
  .max(64)
  .refine(
    items =>
      items.reduce(
        (bytes, item) => bytes + utf8Encoder.encode(item.name).byteLength,
        0
      ) <= 16_384
  )

const preparationSummarySchema = z
  .strictObject({
    preparationId: uuidSchema,
    infoHash: infoHashSchema,
    name: boundedNameSchema,
    length: z.number().int().nonnegative().safe(),
    fileCount: z.number().int().min(1).max(100_000),
    selectedFileCount: z.number().int().min(0).max(100_000),
    private: z.boolean(),
    expiresAtMs: z.number().int().nonnegative().safe(),
    warnings: z
      .array(
        z.enum([
          'DHT_EXPOSURE_USED',
          'TRACKER_TRANSPORT_DISABLED',
          'WEB_SEED_DISABLED',
          'WEB_SEED_INVALID',
          'XS_REMOVED'
        ])
      )
      .max(5)
      .refine(warnings => new Set(warnings).size === warnings.length)
  })
  .refine(value => value.selectedFileCount <= value.fileCount)

const pageResultFields = {
  nextCursor: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().max(100_000)
} as const

function isValidPageResult(value: {
  items: readonly unknown[]
  nextCursor: number | null
  total: number
}): boolean {
  return (
    value.items.length <= value.total &&
    (value.nextCursor === null || value.nextCursor <= value.total)
  )
}

const engineCommandSuccessSchema = z.discriminatedUnion('command', [
  z.strictObject({
    command: z.literal('open-preparation'),
    value: preparationSummarySchema
  }),
  z.strictObject({
    command: z.literal('get-preparation-files'),
    value: z
      .strictObject({
        preparationId: uuidSchema,
        items: torrentFileSummaryPageSchema,
        ...pageResultFields
      })
      .refine(isValidPageResult)
  }),
  z.strictObject({
    command: z.literal('update-preparation-selection'),
    value: z.strictObject({
      preparationId: uuidSchema,
      selectedFileCount: z.number().int().min(0).max(100_000)
    })
  }),
  z.strictObject({
    command: z.literal('commit-preparation'),
    value: z.strictObject({
      preparationId: uuidSchema,
      torrent: torrentSummarySchema
    })
  }),
  z.strictObject({
    command: z.literal('discard-preparation'),
    value: z.strictObject({
      preparationId: uuidSchema,
      discarded: z.literal(true)
    })
  }),
  z.strictObject({
    command: z.literal('restore-torrent'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      torrent: torrentSummarySchema
    })
  }),
  z.strictObject({
    command: z.literal('list-torrents'),
    value: z
      .strictObject({
        items: torrentSummaryPageSchema,
        ...pageResultFields
      })
      .refine(isValidPageResult)
  }),
  z.strictObject({
    command: z.literal('get-torrent-files'),
    value: z
      .strictObject({
        infoHash: infoHashSchema,
        items: torrentFileSummaryPageSchema,
        ...pageResultFields
      })
      .refine(isValidPageResult)
  }),
  z.strictObject({
    command: z.literal('list-legacy-imports'),
    value: z
      .strictObject({
        items: legacyImportPageSchema,
        skippedCount: z.number().int().nonnegative().max(100_000),
        ...pageResultFields
      })
      .refine(isValidPageResult)
  }),
  z.strictObject({
    command: z.literal('import-legacy-torrent'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      torrent: torrentSummarySchema
    })
  }),
  z.strictObject({
    command: z.literal('set-torrent-selection'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      selectedFileCount: z.number().int().min(0).max(100_000)
    })
  }),
  z.strictObject({
    command: z.literal('pause-torrent'),
    value: torrentSummarySchema
  }),
  z.strictObject({
    command: z.literal('resume-torrent'),
    value: torrentSummarySchema
  }),
  z.strictObject({
    command: z.literal('remove-torrent'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      removed: z.literal(true)
    })
  }),
  z.strictObject({
    command: z.literal('create-torrent'),
    value: z.strictObject({
      operationId: uuidSchema,
      torrent: torrentSummarySchema
    })
  }),
  z.strictObject({
    command: z.literal('open-media'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      fileIndex: z.number().int().min(0).max(99_999),
      leaseId: uuidSchema,
      url: z
        .string()
        .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/media\/[A-Za-z0-9_-]{43}$/u)
        .refine(value => {
          const port = Number(
            /^http:\/\/127\.0\.0\.1:(\d{1,5})\//u.exec(value)?.[1]
          )
          return port >= 1 && port <= 65_535
        }),
      expiresAtMs: z.number().int().nonnegative().safe()
    })
  }),
  z.strictObject({
    command: z.literal('open-subtitles'),
    value: z.strictObject({
      infoHash: infoHashSchema,
      tracks: z
        .array(
          z.strictObject({
            fileIndex: z.number().int().min(0).max(99_999),
            label: z.string().min(1).max(64),
            language: z.string().max(16),
            leaseId: uuidSchema,
            url: z
              .string()
              .regex(
                /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/media\/[A-Za-z0-9_-]{43}$/u
              )
          })
        )
        .max(8)
    })
  }),
  z.strictObject({
    command: z.literal('heartbeat-media'),
    value: z.strictObject({
      leaseId: uuidSchema,
      expiresAtMs: z.number().int().nonnegative().safe()
    })
  }),
  z.strictObject({
    command: z.literal('close-media'),
    value: z.strictObject({
      leaseId: uuidSchema,
      closed: z.literal(true)
    })
  })
])

const engineCommandErrorSchema = z.strictObject({
  command: engineCommandNameSchema,
  code: z.enum([
    'ABORTED',
    'ALREADY_EXISTS',
    'DHT_CONSENT_REQUIRED',
    'ENGINE_NOT_READY',
    'INPUT_INVALID',
    'INTERNAL',
    'NOT_FOUND',
    'PATH_NOT_AUTHORIZED',
    'STATE_CONFLICT',
    'TIMEOUT',
    'UNSUPPORTED'
  ]),
  displayMessage: boundedMessageSchema,
  retryable: z.boolean()
})

export const engineCommandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    result: engineCommandSuccessSchema
  }),
  z.strictObject({
    ok: z.literal(false),
    error: engineCommandErrorSchema
  })
])

export type EngineCommandResult = z.infer<typeof engineCommandResultSchema>

export const engineEventSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('torrent-updated'),
    payload: torrentSummarySchema
  }),
  z.strictObject({
    event: z.literal('torrent-removed'),
    payload: z.strictObject({
      infoHash: infoHashSchema
    })
  }),
  z.strictObject({
    event: z.literal('creation-progress'),
    payload: z
      .strictObject({
        operationId: uuidSchema,
        hashedBytes: z.number().int().nonnegative().safe(),
        totalBytes: z.number().int().nonnegative().safe()
      })
      .refine(value => value.hashedBytes <= value.totalBytes)
  }),
  z.strictObject({
    event: z.literal('preparation-expired'),
    payload: z.strictObject({
      preparationId: uuidSchema
    })
  }),
  z.strictObject({
    event: z.literal('media-revoked'),
    payload: z.strictObject({
      leaseId: uuidSchema,
      reason: z.enum(['CLOSED', 'EXPIRED', 'PAUSED', 'REMOVED', 'RESTARTED'])
    })
  })
])

export type EngineEvent = z.infer<typeof engineEventSchema>

export function engineResultMatchesOperation(
  result: EngineCommandResult,
  operation: EngineCommand
): boolean {
  if (!result.ok) return result.error.command === operation.command

  switch (operation.command) {
    case 'open-preparation':
    case 'list-torrents':
    case 'list-legacy-imports':
      return result.result.command === operation.command
    case 'import-legacy-torrent':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash
      )
    case 'get-preparation-files':
    case 'update-preparation-selection':
    case 'commit-preparation':
    case 'discard-preparation':
      return (
        result.result.command === operation.command &&
        result.result.value.preparationId === operation.payload.preparationId
      )
    case 'get-torrent-files':
    case 'restore-torrent':
    case 'set-torrent-selection':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash
      )
    case 'pause-torrent':
    case 'resume-torrent':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash
      )
    case 'remove-torrent':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash
      )
    case 'create-torrent':
      return (
        result.result.command === operation.command &&
        result.result.value.operationId === operation.payload.operationId
      )
    case 'open-media':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash &&
        result.result.value.fileIndex === operation.payload.fileIndex
      )
    case 'open-subtitles':
      return (
        result.result.command === operation.command &&
        result.result.value.infoHash === operation.payload.infoHash
      )
    case 'heartbeat-media':
    case 'close-media':
      return (
        result.result.command === operation.command &&
        result.result.value.leaseId === operation.payload.leaseId
      )
  }
}
