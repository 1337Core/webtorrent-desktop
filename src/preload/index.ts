import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  bootstrapResultSchema,
  DESKTOP_BOOTSTRAP_CHANNEL,
  choosePathResultSchema,
  contextMenuResultSchema,
  DESKTOP_CHOOSE_PATH_CHANNEL,
  DESKTOP_CONTEXT_MENU_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  DESKTOP_EXPORT_TORRENT_CHANNEL,
  DESKTOP_EXTERNAL_PLAYER_CHANNEL,
  DESKTOP_MENU_ACTION_CHANNEL,
  DESKTOP_OPEN_INTENT_CHANNEL,
  DESKTOP_PREFERENCES_CHANNEL,
  DESKTOP_TORRENT_COMMAND_CHANNEL,
  ENGINE_STATUS_CHANNEL,
  engineStatusEventSchema,
  preloadTrustProofSchema,
  PROTOCOL_VERSION,
  externalPlayerResultSchema,
  exportTorrentResultSchema,
  menuActionEventSchema,
  openIntentEventSchema,
  restartEngineResultSchema,
  setPreferencesResultSchema,
  torrentCommandResultSchema,
  type BootstrapResult,
  type ChoosePathResult,
  type ContextMenuResult,
  type EngineCommand,
  type ExternalPlayerResult,
  type ExportTorrentResult,
  type MenuActionEvent,
  type OpenIntentEvent,
  type SetPreferencesResult,
  type TorrentCommandResult,
  type EngineStatusEvent,
  type EngineStatus,
  type RestartEngineResult
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'

const INVOKE_TIMEOUT_MS = 5_000
/** Native open/save panels may remain open while the owner makes a choice. */
const INTERACTIVE_INVOKE_TIMEOUT_MS = 15 * 60_000
/** A drop carries a bounded number of torrents, never a whole folder tree. */
const MAX_DROPPED_FILES = 32
const RESULT_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
const EVENT_BUDGET = {
  maxBytes: 16 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}
let latestEngineStatusEvent: EngineStatusEvent | null = null
type ProtocolErrorResult = Extract<BootstrapResult, { ok: false }>

if (
  process.contextIsolated !== true ||
  process.sandboxed !== true ||
  process.isMainFrame !== true
) {
  throw new Error('Preload trust boundary verification failed')
}

const preloadTrustProof = preloadTrustProofSchema.parse({
  contextIsolated: process.contextIsolated,
  isMainFrame: process.isMainFrame,
  sandboxed: process.sandboxed
})

function protocolError(
  requestId: string,
  displayMessage: string
): ProtocolErrorResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: 'PROTOCOL_MISMATCH',
      retryable: false,
      displayMessage
    }
  }
}

async function invokeBounded(
  channel: string,
  request: unknown,
  timeoutMs = INVOKE_TIMEOUT_MS
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      ipcRenderer.invoke(channel, request),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('IPC request timed out')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function getBootstrap(): Promise<BootstrapResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_BOOTSTRAP_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'bootstrap',
      payload: { preloadTrustProof }
    })
    if (!checkPayloadBudget(value, RESULT_BUDGET).ok) {
      return protocolError(
        requestId,
        'The bootstrap response exceeded its fixed size limit.'
      )
    }

    const result = bootstrapResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid bootstrap response.'
      )
    }
    if (
      result.data.ok &&
      latestEngineStatusEvent &&
      latestEngineStatusEvent.sequence >
        result.data.value.engineStatusEvent.sequence
    ) {
      return bootstrapResultSchema.parse({
        ...result.data,
        value: {
          ...result.data.value,
          engineStatusEvent: latestEngineStatusEvent
        }
      })
    }
    return result.data
  } catch {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        retryable: true,
        displayMessage: 'The application did not answer the bootstrap request.'
      }
    }
  }
}

async function restartEngine(): Promise<RestartEngineResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_ENGINE_RESTART_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'restartEngine',
      payload: {}
    })
    if (!checkPayloadBudget(value, RESULT_BUDGET).ok) {
      return protocolError(
        requestId,
        'The engine restart response exceeded its fixed size limit.'
      )
    }

    const result = restartEngineResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid engine restart response.'
      )
    }
    return result.data
  } catch {
    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        retryable: true,
        displayMessage:
          'The application did not answer the engine restart request.'
      }
    }
  }
}

function onEngineStatus(listener: (status: EngineStatus) => void): () => void {
  let active = true
  let lastSequence = -1
  const wrappedListener = (
    _event: Electron.IpcRendererEvent,
    value: unknown
  ): void => {
    if (!active || !checkPayloadBudget(value, EVENT_BUDGET).ok) return

    const parsed = engineStatusEventSchema.safeParse(value)
    if (!parsed.success || parsed.data.sequence <= lastSequence) return
    lastSequence = parsed.data.sequence
    if (
      !latestEngineStatusEvent ||
      parsed.data.sequence > latestEngineStatusEvent.sequence
    ) {
      latestEngineStatusEvent = parsed.data
    }
    listener(parsed.data.status)
  }

  ipcRenderer.on(ENGINE_STATUS_CHANNEL, wrappedListener)
  return () => {
    if (!active) return
    active = false
    ipcRenderer.removeListener(ENGINE_STATUS_CHANNEL, wrappedListener)
  }
}

/**
 * The renderer's only torrent capability. It carries a validated engine
 * command and returns a validated engine result; no path, handle, or raw
 * transport ever crosses this boundary.
 */
async function runTorrentCommand(
  operation: EngineCommand
): Promise<TorrentCommandResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_TORRENT_COMMAND_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'torrentCommand',
      payload: { operation }
    })
    if (!checkPayloadBudget(value, RESULT_BUDGET).ok) {
      return protocolError(
        requestId,
        'The torrent response exceeded its fixed size limit.'
      ) as TorrentCommandResult
    }

    const result = torrentCommandResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid torrent response.'
      ) as TorrentCommandResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The torrent command could not be completed.'
    ) as TorrentCommandResult
  }
}

/** Opens a main-owned chooser and returns only the path the user picked. */
async function choosePath(
  kind: 'application' | 'directory' | 'source' | 'subtitle' | 'torrent-file'
): Promise<ChoosePathResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(
      DESKTOP_CHOOSE_PATH_CHANNEL,
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command: 'choosePath',
        payload: { kind }
      },
      INTERACTIVE_INVOKE_TIMEOUT_MS
    )
    const result = choosePathResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid path response.'
      ) as ChoosePathResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The chooser could not be opened.'
    ) as ChoosePathResult
  }
}

/** Opens main's save dialog for one already-archived torrent. */
async function exportTorrent(infoHash: string): Promise<ExportTorrentResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(
      DESKTOP_EXPORT_TORRENT_CHANNEL,
      {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        command: 'exportTorrent',
        payload: { infoHash }
      },
      INTERACTIVE_INVOKE_TIMEOUT_MS
    )
    const result = exportTorrentResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid export response.'
      ) as ExportTorrentResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The torrent save dialog could not be opened.'
    ) as ExportTorrentResult
  }
}

/** Asks main for the original right-click menu on one visible torrent. */
async function openTorrentMenu(infoHash: string): Promise<ContextMenuResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_CONTEXT_MENU_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'openContextMenu',
      payload: { infoHash }
    })
    const result = contextMenuResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid menu response.'
      ) as ContextMenuResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The menu could not be opened.'
    ) as ContextMenuResult
  }
}

/**
 * Resolves dropped `.torrent` files to the paths the OS actually handed over.
 * The renderer never learns a path it did not receive from a drop, and the
 * engine revalidates every path before reading it.
 */
function resolveDroppedTorrents(files: ReadonlyArray<File>): string[] {
  const paths: string[] = []
  for (const file of files.slice(0, MAX_DROPPED_FILES)) {
    if (!file.name.toLowerCase().endsWith('.torrent')) continue
    let resolved: string
    try {
      resolved = webUtils.getPathForFile(file)
    } catch {
      continue
    }
    if (resolved !== '' && resolved.length <= 4_096) paths.push(resolved)
  }
  return paths
}

/** Records chosen preference paths; main validates and persists them. */
async function setPreferences(
  update: Readonly<{
    downloadRoot?: string
    externalPlayer?: string | null
    torrentsFolder?: string | null
  }>
): Promise<SetPreferencesResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_PREFERENCES_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'setPreferences',
      payload: update
    })
    const result = setPreferencesResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned invalid preferences.'
      ) as SetPreferencesResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The preference could not be saved.'
    ) as SetPreferencesResult
  }
}

/** Menu actions are pushed by main; the renderer only surfaces a section. */
function onMenuAction(
  listener: (action: MenuActionEvent['action']) => void
): () => void {
  const handler = (_event: unknown, value: unknown): void => {
    const parsed = menuActionEventSchema.safeParse(value)
    if (!parsed.success) return
    listener(parsed.data.action)
  }
  ipcRenderer.on(DESKTOP_MENU_ACTION_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(DESKTOP_MENU_ACTION_CHANNEL, handler)
  }
}

/** Finder and magnet opens arrive here; the renderer prepares them. */
function onOpenIntent(
  listener: (intent: OpenIntentEvent['intent']) => void
): () => void {
  const handler = (_event: unknown, value: unknown): void => {
    const parsed = openIntentEventSchema.safeParse(value)
    if (!parsed.success) return
    listener(parsed.data.intent)
  }
  ipcRenderer.on(DESKTOP_OPEN_INTENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(DESKTOP_OPEN_INTENT_CHANNEL, handler)
  }
}

/** Hands one already-minted media URL to the owner's configured player. */
async function openExternalPlayer(
  mediaUrl: string
): Promise<ExternalPlayerResult> {
  const requestId = crypto.randomUUID()
  try {
    const value = await invokeBounded(DESKTOP_EXTERNAL_PLAYER_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      command: 'openExternalPlayer',
      payload: { mediaUrl }
    })
    const result = externalPlayerResultSchema.safeParse(value)
    if (!result.success || result.data.requestId !== requestId) {
      return protocolError(
        requestId,
        'The application returned an invalid player response.'
      ) as ExternalPlayerResult
    }
    return result.data
  } catch {
    return protocolError(
      requestId,
      'The external player could not be started.'
    ) as ExternalPlayerResult
  }
}

contextBridge.exposeInMainWorld(
  'desktop',
  Object.freeze({
    choosePath,
    exportTorrent,
    getBootstrap,
    openExternalPlayer,
    openTorrentMenu,
    resolveDroppedTorrents,
    restartEngine,
    runTorrentCommand,
    setPreferences,
    onEngineStatus,
    onMenuAction,
    onOpenIntent
  })
)
