import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { ExternalSubtitleGrant } from '../shared/engine-api'
import {
  bootstrapRequestSchema,
  bootstrapResultSchema,
  DESKTOP_BOOTSTRAP_CHANNEL,
  choosePathRequestSchema,
  choosePathResultSchema,
  externalPlayerRequestSchema,
  externalPlayerResultSchema,
  contextMenuRequestSchema,
  contextMenuResultSchema,
  DESKTOP_CHOOSE_PATH_CHANNEL,
  DESKTOP_CONTEXT_MENU_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  DESKTOP_EXPORT_TORRENT_CHANNEL,
  DESKTOP_EXTERNAL_PLAYER_CHANNEL,
  DESKTOP_PREFERENCES_CHANNEL,
  DESKTOP_TORRENT_COMMAND_CHANNEL,
  exportTorrentRequestSchema,
  exportTorrentResultSchema,
  PROTOCOL_VERSION,
  restartEngineRequestSchema,
  restartEngineResultSchema,
  setPreferencesRequestSchema,
  setPreferencesResultSchema,
  torrentCommandRequestSchema,
  torrentCommandResultSchema,
  type BootstrapResult,
  type EngineStatusEvent,
  type PreloadTrustProof,
  type AppState,
  type RestartEngineResult,
  type RuntimeInfo
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'
import type { Diagnostics } from './diagnostics'
import type { EngineSupervisor } from './engine-supervisor'
import type { AppStateStore } from './state-store'
import type { TorrentLibrary } from './torrent-library'
import { isTrustedRendererEvent } from './trusted-renderer'
import { captureExternalSubtitleGrant } from './subtitle-file-grant'

const REQUEST_BUDGET = {
  maxBytes: 4 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const RESULT_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const MAX_RECENT_REQUESTS = 256
const MAX_SUBTITLE_PATH_GRANTS = 8
const SUBTITLE_PATH_GRANT_TTL_MS = 60_000

type DesktopIpcOptions = {
  /** Binds a native subtitle choice to its canonical filesystem identity. */
  captureSubtitleGrant?: (
    selectedPath: string
  ) => Promise<ExternalSubtitleGrant>
  /** Launches the owner's chosen player; absent until one is configured. */
  openExternalPlayer?: (mediaUrl: string) => Promise<void>
  /** Owns the save dialog and the privileged engine export command. */
  exportTorrent?: (infoHash: string) => Promise<boolean>
  /** Lets main react to a saved preference, such as the watched folder. */
  onPreferencesChanged?: (preferences: AppState['preferences']) => void
  /**
   * Main owns the dialog; the renderer only receives the chosen path and, for
   * a creation source, the file count and total size main measured itself.
   */
  choosePath?: (
    kind: 'application' | 'directory' | 'source' | 'subtitle' | 'torrent-file'
  ) => Promise<{
    path: string | null
    summary: { fileCount: number; totalBytes: number } | null
  }>
  diagnostics: Diagnostics
  engineSupervisor: EngineSupervisor
  getEngineStatusEvent: () => EngineStatusEvent
  onBootstrap: (trustProof: PreloadTrustProof) => void
  runtime: RuntimeInfo
  stateStore: AppStateStore
  /** Pops the main-owned right-click menu for one torrent. */
  openTorrentMenu?: (infoHash: string) => boolean
  /** Keeps the durable library current from the commands main validates. */
  torrentLibrary?: TorrentLibrary
  window: BrowserWindow
}

function candidateRequestId(value: unknown): string | null {
  if (
    value &&
    typeof value === 'object' &&
    'requestId' in value &&
    typeof value.requestId === 'string'
  ) {
    const parsed = z.string().uuid().safeParse(value.requestId)
    return parsed.success ? parsed.data : null
  }
  return null
}

function errorResult(
  requestId: string | null,
  code:
    | 'DUPLICATE_REQUEST'
    | 'ENGINE_UNAVAILABLE'
    | 'INTERNAL'
    | 'INVALID_REQUEST'
    | 'PAYLOAD_TOO_LARGE'
    | 'UNAUTHORIZED_SENDER',
  displayMessage: string,
  retryable: boolean
): BootstrapResult | RestartEngineResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code,
      retryable,
      displayMessage
    }
  }
}

export function registerDesktopIpc(options: DesktopIpcOptions): () => void {
  const {
    captureSubtitleGrant = captureExternalSubtitleGrant,
    choosePath,
    diagnostics,
    exportTorrent,
    onPreferencesChanged,
    openExternalPlayer,
    engineSupervisor,
    getEngineStatusEvent,
    onBootstrap,
    openTorrentMenu,
    runtime,
    stateStore,
    torrentLibrary,
    window
  } = options
  const frameIpc = window.webContents.mainFrame.ipc
  const recentRequests = new Set<string>()
  const requestOrder: string[] = []
  const subtitlePathGrants = new Map<
    string,
    Readonly<{ expiresAtMs: number; grant: ExternalSubtitleGrant }>
  >()

  function pruneSubtitlePathGrants(): void {
    const now = Date.now()
    for (const [grantedPath, record] of subtitlePathGrants) {
      if (record.expiresAtMs <= now) subtitlePathGrants.delete(grantedPath)
    }
  }

  function grantSubtitlePath(
    grantedPath: string,
    grant: ExternalSubtitleGrant
  ): void {
    pruneSubtitlePathGrants()
    subtitlePathGrants.delete(grantedPath)
    while (subtitlePathGrants.size >= MAX_SUBTITLE_PATH_GRANTS) {
      const oldest = subtitlePathGrants.keys().next().value
      if (typeof oldest !== 'string') break
      subtitlePathGrants.delete(oldest)
    }
    subtitlePathGrants.set(grantedPath, {
      expiresAtMs: Date.now() + SUBTITLE_PATH_GRANT_TTL_MS,
      grant
    })
  }

  function consumeSubtitlePath(
    grantedPath: string
  ): ExternalSubtitleGrant | null {
    pruneSubtitlePathGrants()
    const record = subtitlePathGrants.get(grantedPath)
    subtitlePathGrants.delete(grantedPath)
    return record?.grant ?? null
  }

  function authorize(
    event: IpcMainInvokeEvent,
    value: unknown
  ): BootstrapResult | RestartEngineResult | null {
    if (!isTrustedRendererEvent(event, window)) {
      diagnostics.warn('ipc.unauthorized')
      return errorResult(
        null,
        'UNAUTHORIZED_SENDER',
        'The application rejected an unauthorized request.',
        false
      )
    }

    if (!checkPayloadBudget(value, REQUEST_BUDGET).ok) {
      diagnostics.warn('ipc.request-over-budget')
      return errorResult(
        candidateRequestId(value),
        'PAYLOAD_TOO_LARGE',
        'The application request exceeded its fixed size limit.',
        false
      )
    }

    return null
  }

  function rememberRequest(
    requestId: string
  ): BootstrapResult | RestartEngineResult | null {
    if (recentRequests.has(requestId)) {
      return errorResult(
        requestId,
        'DUPLICATE_REQUEST',
        'The application rejected a duplicate request.',
        false
      )
    }

    recentRequests.add(requestId)
    requestOrder.push(requestId)
    if (requestOrder.length > MAX_RECENT_REQUESTS) {
      const oldest = requestOrder.shift()
      if (oldest) recentRequests.delete(oldest)
    }
    return null
  }

  frameIpc.handle(DESKTOP_BOOTSTRAP_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return bootstrapResultSchema.parse(rejected)

    const request = bootstrapRequestSchema.safeParse(value)
    if (!request.success) {
      return bootstrapResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received an invalid bootstrap request.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return bootstrapResultSchema.parse(duplicate)

    try {
      const state = stateStore.snapshot()
      const result: BootstrapResult = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          engineStatusEvent: getEngineStatusEvent(),
          state: {
            schemaVersion: state.schemaVersion,
            revision: state.revision,
            preferences: state.preferences
          },
          runtime
        }
      }
      if (!checkPayloadBudget(result, RESULT_BUDGET).ok) {
        throw new Error('Bootstrap result exceeded its fixed payload budget')
      }
      const parsedResult = bootstrapResultSchema.parse(result)
      onBootstrap(request.data.payload.preloadTrustProof)
      return parsedResult
    } catch {
      diagnostics.error('ipc.bootstrap-failed')
      return bootstrapResultSchema.parse(
        errorResult(
          request.data.requestId,
          'INTERNAL',
          'The application could not prepare its initial state.',
          true
        )
      )
    }
  })

  frameIpc.handle(DESKTOP_ENGINE_RESTART_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return restartEngineResultSchema.parse(rejected)

    const request = restartEngineRequestSchema.safeParse(value)
    if (!request.success) {
      return restartEngineResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received an invalid engine restart request.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return restartEngineResultSchema.parse(duplicate)

    if (!engineSupervisor.restart()) {
      return restartEngineResultSchema.parse(
        errorResult(
          request.data.requestId,
          'ENGINE_UNAVAILABLE',
          'The torrent engine is not in a restartable state.',
          true
        )
      )
    }

    return restartEngineResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.data.requestId,
      ok: true,
      value: {
        accepted: true,
        status: engineSupervisor.status()
      }
    })
  })

  /**
   * Torrent commands cross one validated channel. Main never forwards an
   * arbitrary payload: the operation is parsed against the engine contract
   * here, and the engine result is parsed again before it reaches the
   * renderer.
   */
  frameIpc.handle(
    DESKTOP_TORRENT_COMMAND_CHANNEL,
    async (event, value: unknown) => {
      const rejected = authorize(event, value)
      if (rejected) return torrentCommandResultSchema.parse(rejected)

      const request = torrentCommandRequestSchema.safeParse(value)
      if (
        !request.success ||
        request.data.payload.operation.command === 'export-torrent'
      ) {
        return torrentCommandResultSchema.parse(
          errorResult(
            candidateRequestId(value),
            'INVALID_REQUEST',
            'The application received an invalid torrent command.',
            false
          )
        )
      }

      let operation = request.data.payload.operation
      if (operation.command === 'open-external-subtitle') {
        const grant = consumeSubtitlePath(operation.payload.path)
        if (!grant) {
          return torrentCommandResultSchema.parse(
            errorResult(
              request.data.requestId,
              'INVALID_REQUEST',
              'Select that subtitle file before opening it.',
              false
            )
          )
        }
        operation = {
          ...operation,
          payload: { ...operation.payload, grant }
        }
      }

      const duplicate = rememberRequest(request.data.requestId)
      if (duplicate) return torrentCommandResultSchema.parse(duplicate)

      const result = await engineSupervisor.execute(operation)
      torrentLibrary?.record(operation, result)
      return torrentCommandResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: result
      })
    }
  )

  frameIpc.handle(
    DESKTOP_EXPORT_TORRENT_CHANNEL,
    async (event, value: unknown) => {
      const rejected = authorize(event, value)
      if (rejected) return exportTorrentResultSchema.parse(rejected)

      const request = exportTorrentRequestSchema.safeParse(value)
      if (!request.success) {
        return exportTorrentResultSchema.parse(
          errorResult(
            candidateRequestId(value),
            'INVALID_REQUEST',
            'The application received an invalid export request.',
            false
          )
        )
      }

      const duplicate = rememberRequest(request.data.requestId)
      if (duplicate) return exportTorrentResultSchema.parse(duplicate)
      if (!exportTorrent) {
        return exportTorrentResultSchema.parse(
          errorResult(
            request.data.requestId,
            'INTERNAL',
            'The torrent file could not be saved.',
            true
          )
        )
      }

      try {
        const saved = await exportTorrent(request.data.payload.infoHash)
        return exportTorrentResultSchema.parse({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.data.requestId,
          ok: true,
          value: { saved }
        })
      } catch {
        return exportTorrentResultSchema.parse(
          errorResult(
            request.data.requestId,
            'INTERNAL',
            'The torrent file could not be saved.',
            true
          )
        )
      }
    }
  )

  frameIpc.handle(
    DESKTOP_CHOOSE_PATH_CHANNEL,
    async (event, value: unknown) => {
      const rejected = authorize(event, value)
      if (rejected) return choosePathResultSchema.parse(rejected)

      const request = choosePathRequestSchema.safeParse(value)
      if (!request.success) {
        return choosePathResultSchema.parse(
          errorResult(
            candidateRequestId(value),
            'INVALID_REQUEST',
            'The application received an invalid path request.',
            false
          )
        )
      }

      const duplicate = rememberRequest(request.data.requestId)
      if (duplicate) return choosePathResultSchema.parse(duplicate)

      const chosen = choosePath
        ? await choosePath(request.data.payload.kind)
        : { path: null, summary: null }
      if (request.data.payload.kind === 'subtitle' && chosen.path !== null) {
        try {
          grantSubtitlePath(
            chosen.path,
            await captureSubtitleGrant(chosen.path)
          )
        } catch {
          diagnostics.warn('subtitle.grant-capture-failed')
          return choosePathResultSchema.parse(
            errorResult(
              request.data.requestId,
              'INTERNAL',
              'The selected subtitle file could not be authorized.',
              true
            )
          )
        }
      }
      return choosePathResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: { path: chosen.path, summary: chosen.summary }
      })
    }
  )

  frameIpc.handle(DESKTOP_PREFERENCES_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return setPreferencesResultSchema.parse(rejected)

    const request = setPreferencesRequestSchema.safeParse(value)
    if (!request.success) {
      return setPreferencesResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received invalid preferences.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return setPreferencesResultSchema.parse(duplicate)

    try {
      const state = stateStore.setPreferences(request.data.payload)
      onPreferencesChanged?.(state.preferences)
      return setPreferencesResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: { preferences: state.preferences }
      })
    } catch {
      return setPreferencesResultSchema.parse(
        errorResult(
          request.data.requestId,
          'INVALID_REQUEST',
          'That download folder cannot be used.',
          false
        )
      )
    }
  })

  frameIpc.handle(
    DESKTOP_EXTERNAL_PLAYER_CHANNEL,
    async (event, value: unknown) => {
      const rejected = authorize(event, value)
      if (rejected) return externalPlayerResultSchema.parse(rejected)

      const request = externalPlayerRequestSchema.safeParse(value)
      if (!request.success) {
        return externalPlayerResultSchema.parse(
          errorResult(
            candidateRequestId(value),
            'INVALID_REQUEST',
            'The application received an invalid player request.',
            false
          )
        )
      }

      const duplicate = rememberRequest(request.data.requestId)
      if (duplicate) return externalPlayerResultSchema.parse(duplicate)

      if (!openExternalPlayer) {
        return externalPlayerResultSchema.parse(
          errorResult(
            request.data.requestId,
            'INVALID_REQUEST',
            'No external player is configured.',
            false
          )
        )
      }

      try {
        await openExternalPlayer(request.data.payload.mediaUrl)
      } catch {
        return externalPlayerResultSchema.parse(
          errorResult(
            request.data.requestId,
            'INTERNAL',
            'The external player could not be started.',
            false
          )
        )
      }
      return externalPlayerResultSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.data.requestId,
        ok: true,
        value: { launched: true }
      })
    }
  )

  /**
   * The renderer may ask for the original right-click menu on one torrent it
   * can already see. Main owns the menu and every action it performs.
   */
  frameIpc.handle(DESKTOP_CONTEXT_MENU_CHANNEL, (event, value: unknown) => {
    const rejected = authorize(event, value)
    if (rejected) return contextMenuResultSchema.parse(rejected)

    const request = contextMenuRequestSchema.safeParse(value)
    if (!request.success) {
      return contextMenuResultSchema.parse(
        errorResult(
          candidateRequestId(value),
          'INVALID_REQUEST',
          'The application received an invalid menu request.',
          false
        )
      )
    }

    const duplicate = rememberRequest(request.data.requestId)
    if (duplicate) return contextMenuResultSchema.parse(duplicate)

    return contextMenuResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.data.requestId,
      ok: true,
      value: {
        shown: openTorrentMenu?.(request.data.payload.infoHash) ?? false
      }
    })
  })

  return () => {
    subtitlePathGrants.clear()
    frameIpc.removeHandler(DESKTOP_BOOTSTRAP_CHANNEL)
    frameIpc.removeHandler(DESKTOP_CONTEXT_MENU_CHANNEL)
    frameIpc.removeHandler(DESKTOP_EXPORT_TORRENT_CHANNEL)
    frameIpc.removeHandler(DESKTOP_EXTERNAL_PLAYER_CHANNEL)
    frameIpc.removeHandler(DESKTOP_CHOOSE_PATH_CHANNEL)
    frameIpc.removeHandler(DESKTOP_PREFERENCES_CHANNEL)
    frameIpc.removeHandler(DESKTOP_ENGINE_RESTART_CHANNEL)
    frameIpc.removeHandler(DESKTOP_TORRENT_COMMAND_CHANNEL)
  }
}
