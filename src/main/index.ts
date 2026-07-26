import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  protocol,
  screen,
  shell,
  type BrowserWindowConstructorOptions,
  type Rectangle,
  type Session
} from 'electron'
import { z } from 'zod'
import {
  APP_NAME,
  DESKTOP_MENU_ACTION_CHANNEL,
  DESKTOP_OPEN_INTENT_CHANNEL,
  ENGINE_STATUS_CHANNEL,
  PROTOCOL_VERSION,
  engineStatusEventSchema,
  runtimeInfoSchema,
  type EngineStatus,
  type EngineStatusEvent,
  type PreloadTrustProof,
  type RuntimeInfo
} from '../shared/contracts'
import { registerApplicationProtocol } from './application-protocol'
import { registerDesktopIpc } from './desktop-ipc'
import { Diagnostics } from './diagnostics'
import {
  SECURE_WEB_PREFERENCES,
  assertRendererWebRtcBlocked,
  configureRendererWebRtcBlocking,
  createUiSession,
  secureWindow
} from './electron-security'
import { EngineSupervisor } from './engine-supervisor'
import { findDangerousLaunchSwitch } from './launch-policy'
import { installAppMenu } from './app-menu'
import { ExternalPlayer } from './external-player'
import { FolderWatcher } from './folder-watcher'
import { DesktopNotifier, DockBadge, PowerSaveGuard } from './os-integration'
import { measureSource } from './source-summary'
import { TorrentHandlers } from './torrent-handlers'
import { AppStateStore } from './state-store'
import { PayloadTrash } from './payload-trash'
import { TorrentContextMenu } from './torrent-context-menu'
import { TorrentLibrary } from './torrent-library'
import { TRUSTED_RENDERER_URL } from './trusted-renderer'

const DEFAULT_WINDOW_BOUNDS = {
  height: 720,
  width: 1080
} as const
const MINIMUM_VISIBLE_WINDOW_EDGE = 80
const WINDOW_BOUNDS_SAVE_DELAY_MS = 500
const SMOKE_TIMEOUT_MS = 40_000
const RESTART_SOAK_COUNT = 25
const RESTART_SOAK_SHUTDOWN_LIMIT_MS = 5_000
const RESTART_SOAK_PERCENTILE_LIMIT_MS = 2_000
const RESTART_SOAK_READY_TIMEOUT_MS = 30_000
const RESTART_SOAK_TIMEOUT_MS = 300_000
const SMOKE_COMPLETION_DELAY_MS = 100
const SMOKE_RUN_ID_ENVIRONMENT_KEY = 'WEBTORRENT_UPDATED_SMOKE_RUN_ID'
const suppliedSmokeRunId = process.env[SMOKE_RUN_ID_ENVIRONMENT_KEY]
if (
  suppliedSmokeRunId !== undefined &&
  !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u.test(suppliedSmokeRunId)
) {
  throw new Error('Invalid smoke-run identifier')
}
const SMOKE_DATA_PREFIX = path.join(
  tmpdir(),
  suppliedSmokeRunId
    ? `webtorrent-updated-smoke-${suppliedSmokeRunId}-`
    : 'webtorrent-updated-smoke-'
)
const SMOKE_NAVIGATION_TARGET = 'app://bundle/not-allowed.html'
let smokeNavigationDeniedObserver: ((url: string) => void) | null = null
const smokeScenario = process.argv.includes('--m2-smoke-crash-loop')
  ? 'crash-loop'
  : process.argv.includes('--m2-smoke-restart')
    ? 'restart'
    : process.argv.includes('--m1-smoke') || process.argv.includes('--m2-smoke')
      ? 'baseline'
      : null
const isMilestoneSmoke = smokeScenario !== null
/**
 * The section 18.5 supervised-restart soak. It shares the smoke build's
 * isolated data root but not its trust-evidence machinery: the workload is the
 * supervisor itself, repeated far past the single restart the smoke proves.
 */
const isRestartSoak = process.argv.includes('--soak-restarts')
const smokeDataRoot =
  isMilestoneSmoke || isRestartSoak ? mkdtempSync(SMOKE_DATA_PREFIX) : null
const rendererSmokeEvidenceSchema = z.strictObject({
  bootstrapCommitted: z.literal(true),
  bufferPresent: z.literal(false),
  desktopApiKeys: z.tuple([
    z.literal('choosePath'),
    z.literal('exportTorrent'),
    z.literal('getBootstrap'),
    z.literal('onEngineStatus'),
    z.literal('onMenuAction'),
    z.literal('onOpenIntent'),
    z.literal('openExternalPlayer'),
    z.literal('openTorrentMenu'),
    z.literal('resolveDroppedTorrents'),
    z.literal('restartEngine'),
    z.literal('runTorrentCommand'),
    z.literal('setPreferences')
  ]),
  navigationDenied: z.literal(true),
  networkFetchDenied: z.literal(true),
  pageUrl: z.literal(TRUSTED_RENDERER_URL),
  permissionState: z.literal('denied'),
  popupDenied: z.literal(true),
  processPresent: z.literal(false),
  rendererBoundary: z.literal('passed'),
  requirePresent: z.literal(false),
  webRtcBlocked: z.literal(true),
  webRtcErrorName: z.literal('NotAllowedError')
})
const rendererSmokeEvidenceWithoutNavigationSchema =
  rendererSmokeEvidenceSchema.omit({
    navigationDenied: true
  })
type RendererSmokeEvidence = z.infer<typeof rendererSmokeEvidenceSchema>

type SmokeTrustEvidence = {
  connectionAllowlist: string
  dedicatedUiSession: boolean
  dnsPrefetchControl: string
  osSandboxed: boolean
  preload: PreloadTrustProof
  renderer: RendererSmokeEvidence
  sessionPersistent: boolean
  sessionStoragePath: string | null
}

async function isUntrustedNavigationDenied(
  window: BrowserWindow
): Promise<boolean> {
  const originalUrl = window.webContents.getURL()

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: boolean, error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      smokeNavigationDeniedObserver = null
      if (error) reject(error)
      else resolve(result)
    }
    smokeNavigationDeniedObserver = url => {
      if (url !== SMOKE_NAVIGATION_TARGET) return
      setTimeout(() => {
        const currentUrl = window.webContents.getURL()
        const denied =
          originalUrl === TRUSTED_RENDERER_URL && currentUrl === originalUrl
        finish(
          denied,
          denied
            ? undefined
            : new Error(
                `Renderer navigation reached ${currentUrl.slice(0, 64)}`
              )
        )
      }, SMOKE_COMPLETION_DELAY_MS)
    }
    const timeout = setTimeout(
      () =>
        finish(
          false,
          new Error(
            `Renderer navigation probe was not observed at ${window.webContents
              .getURL()
              .slice(0, 64)}`
          )
        ),
      2_000
    )

    void window.webContents
      .executeJavaScript(
        `(() => {
          const probe = document.querySelector('[data-smoke-navigation-probe]')
          if (!(probe instanceof HTMLButtonElement)) return false
          setTimeout(() => probe.click(), 0)
          return true
        })()`
      )
      .then(scheduled => {
        if (scheduled !== true) {
          finish(false, new Error('Renderer navigation probe was unavailable'))
        }
      })
      .catch(() =>
        finish(false, new Error('Renderer navigation probe could not run'))
      )
  })
}

function routeActivation(kind: 'file' | 'url', value: string): void {
  const handlers = torrentHandlers
  if (!handlers) {
    if (pendingActivations.length < MAX_PENDING_ACTIVATIONS) {
      pendingActivations.push({ kind, value })
    }
    return
  }
  if (kind === 'url') handlers.handleUrl(value)
  else void handlers.handleFile(value)
}

function drainPendingActivations(): void {
  const queued = pendingActivations.splice(0, pendingActivations.length)
  for (const activation of queued) {
    routeActivation(activation.kind, activation.value)
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  routeActivation('url', url)
})
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  routeActivation('file', filePath)
})

app.setName(APP_NAME)
if (smokeDataRoot) app.setPath('appData', smokeDataRoot)
/**
 * Desktop automation supplies its own throwaway profile and then waits for the
 * DevTools port file inside it. Only the automation build honors it, so the
 * release app always owns its own application-data directory and an E2E run
 * never touches the owner's real profile.
 */
const automationUserDataPath = __WEBTORRENT_UPDATED_E2E_BUILD__
  ? app.commandLine.getSwitchValue('user-data-dir') || null
  : null
const userDataPath =
  automationUserDataPath ?? path.join(app.getPath('appData'), APP_NAME)
mkdirSync(userDataPath, { mode: 0o700, recursive: true })
chmodSync(userDataPath, 0o700)
const logsPath = path.join(userDataPath, 'logs')
mkdirSync(logsPath, { mode: 0o700, recursive: true })
chmodSync(logsPath, 0o700)
app.setPath('userData', userDataPath)
app.setAppLogsPath(logsPath)
app.enableSandbox()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true
    }
  }
])

const diagnostics = new Diagnostics(app.getPath('logs'))

function cleanupSmokeData(): void {
  if (!smokeDataRoot) return
  if (
    !smokeDataRoot.startsWith(SMOKE_DATA_PREFIX) ||
    smokeDataRoot.length <= SMOKE_DATA_PREFIX.length
  ) {
    throw new Error('Refusing to remove an unowned smoke-data path')
  }
  rmSync(smokeDataRoot, { force: true, recursive: true })
}

process.once('exit', cleanupSmokeData)
configureRendererWebRtcBlocking()

let mainWindow: BrowserWindow | null = null
let uiSession: Session | null = null
let stateStore: AppStateStore | null = null
let torrentLibrary: TorrentLibrary | null = null
let engineSupervisor: EngineSupervisor | null = null
/** One restore sweep per engine generation, never one per status event. */
let restoredGenerationId: string | null = null
let unregisterApplicationProtocol: (() => void) | null = null
let unregisterDesktopIpc: (() => void) | null = null
let windowBoundsSaveTimer: NodeJS.Timeout | null = null
let smokeTimeout: NodeJS.Timeout | null = null
let smokeCompletionTimer: NodeJS.Timeout | null = null
let smokeInterventionTimer: NodeJS.Timeout | null = null
let smokeForcedCrashes = 0
let smokeFinalizationStarted = false
let restartSoakStarted = false
/**
 * Cold-start activations.
 *
 * macOS can emit `open-file` and `open-url` before the app is ready, so the
 * listeners are installed at load rather than with the window, and anything
 * that arrives before the handlers exist waits here. A bounded queue keeps a
 * flood of activations from growing without limit.
 */
const MAX_PENDING_ACTIVATIONS = 32
const pendingActivations: Array<
  Readonly<{ kind: 'file' | 'url'; value: string }>
> = []
let torrentHandlers: TorrentHandlers | null = null
type OpenIntent = Parameters<
  NonNullable<ConstructorParameters<typeof TorrentHandlers>[0]['onIntent']>
>[0]
const pendingIntents: OpenIntent[] = []
let deliverPendingIntents: () => void = () => undefined
let lastReadyEngineStatus: Extract<EngineStatus, { state: 'ready' }> | null =
  null
let rendererBootstrapped = false
let preloadTrustProof: PreloadTrustProof | null = null
let shutdownStarted = false
let requestedExitCode = 0
let engineStatusSequence = 0
let latestEngineStatusEvent: EngineStatusEvent = engineStatusEventSchema.parse({
  protocolVersion: PROTOCOL_VERSION,
  eventId: randomUUID(),
  sequence: engineStatusSequence,
  status: {
    state: 'starting',
    generationId: null,
    restartCount: 0
  }
})

function rendererRoot(): string {
  return path.join(import.meta.dirname, '..', 'renderer')
}

function preloadFile(): string {
  return path.join(import.meta.dirname, '..', 'preload', 'index.cjs')
}

function engineFile(): string {
  return path.join(import.meta.dirname, '..', 'engine', 'index.mjs')
}

function intersectionSize(
  first: Rectangle,
  second: Rectangle
): {
  height: number
  width: number
} {
  return {
    height: Math.max(
      0,
      Math.min(first.y + first.height, second.y + second.height) -
        Math.max(first.y, second.y)
    ),
    width: Math.max(
      0,
      Math.min(first.x + first.width, second.x + second.width) -
        Math.max(first.x, second.x)
    )
  }
}

function isWindowVisible(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some(display => {
    const intersection = intersectionSize(bounds, display.workArea)
    return (
      bounds.height <= display.workArea.height &&
      bounds.width <= display.workArea.width &&
      intersection.height >= MINIMUM_VISIBLE_WINDOW_EDGE &&
      intersection.width >= MINIMUM_VISIBLE_WINDOW_EDGE
    )
  })
}

function defaultWindowBounds(): Rectangle {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(DEFAULT_WINDOW_BOUNDS.width, workArea.width)
  const height = Math.min(DEFAULT_WINDOW_BOUNDS.height, workArea.height)
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height
  }
}

function restoredWindowBounds(): Partial<BrowserWindowConstructorOptions> {
  const savedBounds = stateStore?.snapshot().window.main.normalBounds ?? null
  if (savedBounds && isWindowVisible(savedBounds)) return savedBounds
  return defaultWindowBounds()
}

function persistWindowBounds(window = mainWindow): void {
  if (!window || window.isDestroyed() || !stateStore) return

  try {
    stateStore.setWindowBounds(window.getNormalBounds())
  } catch {
    diagnostics.error('state.window-bounds-save-failed')
  }
}

function scheduleWindowBoundsSave(window: BrowserWindow): void {
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer)
  windowBoundsSaveTimer = setTimeout(() => {
    windowBoundsSaveTimer = null
    if (window === mainWindow) persistWindowBounds(window)
  }, WINDOW_BOUNDS_SAVE_DELAY_MS)
}

function runtimeInfo(): RuntimeInfo {
  return runtimeInfoSchema.parse({
    appName: APP_NAME,
    appVersion: app.getVersion(),
    architecture: process.arch,
    chromeVersion: process.versions.chrome,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform
  })
}

function assertWindowSecurity(window: BrowserWindow, session: Session): void {
  if (
    SECURE_WEB_PREFERENCES.contextIsolation !== true ||
    SECURE_WEB_PREFERENCES.nodeIntegration !== false ||
    SECURE_WEB_PREFERENCES.sandbox !== true ||
    SECURE_WEB_PREFERENCES.webSecurity !== true ||
    SECURE_WEB_PREFERENCES.webviewTag !== false ||
    window.webContents.session !== session
  ) {
    throw new Error('Main window did not retain the required security policy')
  }
}

/**
 * A ready engine holds no torrents of its own. Every recorded torrent is
 * rebuilt from its archived bytes once per engine generation, so a restart —
 * and a supervised engine restart — restores the library the owner left.
 */
function restoreLibrary(status: EngineStatus): void {
  if (status.state !== 'ready' || status.generationId === null) return
  if (restoredGenerationId === status.generationId) return
  const library = torrentLibrary
  const supervisor = engineSupervisor
  if (!library || !supervisor) return

  restoredGenerationId = status.generationId
  void library
    .restore(operation => supervisor.execute(operation))
    .catch(() => {
      // A failed sweep is reported by the library itself; the app still runs.
    })
}

function publishEngineStatus(status: EngineStatus): void {
  if (status.state === 'ready') lastReadyEngineStatus = status
  restoreLibrary(status)
  engineStatusSequence += 1
  latestEngineStatusEvent = engineStatusEventSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    eventId: randomUUID(),
    sequence: engineStatusSequence,
    status
  })

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.mainFrame.send(
      ENGINE_STATUS_CHANNEL,
      latestEngineStatusEvent
    )
  }
  scheduleSmokeCompletion()
  scheduleRestartSoak()
}

async function collectSmokeTrustEvidence(): Promise<SmokeTrustEvidence> {
  const window = mainWindow
  const session = uiSession
  const trustProof = preloadTrustProof
  if (!window || window.isDestroyed() || !session || !trustProof) {
    throw new Error('Smoke trust evidence is unavailable')
  }

  await assertRendererWebRtcBlocked(window.webContents)
  const renderer = rendererSmokeEvidenceWithoutNavigationSchema.parse(
    await window.webContents.executeJavaScript(`
      (async () => {
        const wait = milliseconds =>
          new Promise(resolve => setTimeout(resolve, milliseconds))
        // The boundary marker, not a tag name: the shell's markup is free to
        // change without silently voiding this evidence.
        const root = document.querySelector('[data-renderer-boundary]')
        const desktopApiKeys = Object.keys(globalThis.desktop ?? {}).sort()

        const networkFetchDenied = await fetch(
          'https://renderer-egress.invalid/probe',
          { mode: 'no-cors' }
        ).then(
          () => false,
          () => true
        )

        let popupDenied = false
        try {
          const popup = window.open(
            'https://renderer-egress.invalid/popup',
            '_blank'
          )
          popupDenied = popup === null
          popup?.close()
        } catch {
          popupDenied = true
        }

        let permissionState = 'error'
        try {
          permissionState = (
            await navigator.permissions.query({ name: 'geolocation' })
          ).state
        } catch {
          permissionState = 'error'
        }

        let webRtcBlocked = false
        let webRtcErrorName = null
        try {
          const peer = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:renderer-egress.invalid:3478' }]
          })
          peer.createDataChannel('egress-probe')
          await peer.setLocalDescription(await peer.createOffer())
          await wait(200)
          peer.close()
        } catch (error) {
          webRtcErrorName =
            error && typeof error === 'object' && 'name' in error
              ? String(error.name)
              : 'UnknownError'
          webRtcBlocked = webRtcErrorName === 'NotAllowedError'
        }

        return {
          bootstrapCommitted: root?.dataset.bootstrapReady === 'true',
          bufferPresent: typeof globalThis.Buffer !== 'undefined',
          desktopApiKeys,
          networkFetchDenied,
          pageUrl: location.href,
          permissionState,
          popupDenied,
          processPresent: typeof globalThis.process !== 'undefined',
          rendererBoundary: root?.dataset.rendererBoundary ?? 'missing',
          requirePresent: typeof globalThis.require !== 'undefined',
          webRtcBlocked,
          webRtcErrorName
        }
      })()
    `)
  )
  const navigationDenied = await isUntrustedNavigationDenied(window)
  const rendererWithNavigation = rendererSmokeEvidenceSchema.parse({
    ...renderer,
    navigationDenied
  })

  const response = await session.fetch(TRUSTED_RENDERER_URL)
  if (!response.ok) {
    throw new Error('UI session could not re-fetch the application document')
  }
  const connectionAllowlist = response.headers.get('connection-allowlist') ?? ''
  const dnsPrefetchControl =
    response.headers.get('x-dns-prefetch-control') ?? ''
  const dedicatedUiSession =
    window.webContents.session === session &&
    session.isPersistent() === false &&
    session.getStoragePath() === null
  const osSandboxed = isRendererOsSandboxed()
  if (!dedicatedUiSession) {
    throw new Error('The measured UI session was not isolated and ephemeral')
  }
  if (!osSandboxed) {
    throw new Error('The measured renderer process was not OS-sandboxed')
  }
  if (!connectionAllowlist.includes('webrtc=block')) {
    throw new Error('The measured response omitted the WebRTC block')
  }
  if (dnsPrefetchControl.toLowerCase() !== 'off') {
    throw new Error('The measured response did not disable DNS prefetch')
  }

  return {
    connectionAllowlist,
    dedicatedUiSession,
    dnsPrefetchControl,
    osSandboxed,
    preload: trustProof,
    renderer: rendererWithNavigation,
    sessionPersistent: session.isPersistent(),
    sessionStoragePath: session.getStoragePath()
  }
}

function smokeResult(evidence: SmokeTrustEvidence): Record<string, unknown> {
  const state = stateStore?.snapshot()
  return {
    architecture: process.arch,
    electron: process.versions.electron,
    engine: latestEngineStatusEvent.status,
    engineProcessId: engineSupervisor?.processId() ?? null,
    engineRuntime: lastReadyEngineStatus,
    forcedCrashes: smokeForcedCrashes,
    node: process.versions.node,
    protocolVersion: PROTOCOL_VERSION,
    renderer: evidence.renderer,
    result: 'pass',
    scenario: smokeScenario,
    smokeDataIsolated:
      smokeDataRoot !== null && path.dirname(userDataPath) === smokeDataRoot,
    smokeDataRoot,
    state: state
      ? {
          revision: state.revision,
          schemaVersion: state.schemaVersion
        }
      : null,
    trustBoundaries: {
      connectionAllowlist: evidence.connectionAllowlist,
      contextIsolation: evidence.preload.contextIsolated,
      dedicatedUiSession: evidence.dedicatedUiSession,
      dnsPrefetchControl: evidence.dnsPrefetchControl,
      nodeIntegration:
        evidence.renderer.bufferPresent ||
        evidence.renderer.processPresent ||
        evidence.renderer.requirePresent,
      osSandboxed: evidence.osSandboxed,
      preloadMainFrame: evidence.preload.isMainFrame,
      sandbox: evidence.preload.sandboxed,
      sessionPersistent: evidence.sessionPersistent,
      sessionStoragePath: evidence.sessionStoragePath
    }
  }
}

function isSmokeScenarioComplete(): boolean {
  const status = latestEngineStatusEvent.status
  switch (smokeScenario) {
    case 'baseline':
      return status.state === 'ready'
    case 'restart':
      return (
        smokeForcedCrashes === 1 &&
        status.state === 'ready' &&
        status.restartCount === 1
      )
    case 'crash-loop':
      return (
        smokeForcedCrashes === 2 &&
        status.state === 'stopped' &&
        status.code === 'ENGINE_CRASH_LOOP'
      )
    default:
      return false
  }
}

function scheduleSmokeIntervention(): void {
  const targetCrashCount =
    smokeScenario === 'crash-loop' ? 2 : smokeScenario === 'restart' ? 1 : 0
  if (
    !rendererBootstrapped ||
    latestEngineStatusEvent.status.state !== 'ready' ||
    smokeForcedCrashes >= targetCrashCount ||
    smokeInterventionTimer
  ) {
    return
  }

  smokeInterventionTimer = setTimeout(() => {
    smokeInterventionTimer = null
    if (!engineSupervisor?.terminateForSmokeTest()) {
      console.error(
        JSON.stringify({
          forcedCrashes: smokeForcedCrashes,
          result: 'smoke-intervention-failed',
          scenario: smokeScenario
        })
      )
      requestQuit(1)
      return
    }
    smokeForcedCrashes += 1
  }, SMOKE_COMPLETION_DELAY_MS)
}

/**
 * One engine while the supervisor is running, none once it has stopped. The
 * supervisor's own process id is the authority; liveness is read from the
 * operating system rather than from the status the supervisor reports.
 */
function liveEngineProcessCount(): number {
  const processId = engineSupervisor?.processId() ?? null
  if (processId === null) return 0
  try {
    process.kill(processId, 0)
    return 1
  } catch {
    return 0
  }
}

function readyGenerationId(): string | null {
  const status = latestEngineStatusEvent.status
  return status.state === 'ready' ? status.generationId : null
}

/**
 * Waits for a genuinely new generation. Waiting for `ready` alone would settle
 * on the status the previous engine last published, so a restart that never
 * came back would still look successful.
 */
async function waitForEngineReady(
  deadlineMs: number,
  previousGenerationId: string | null
): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const generationId = readyGenerationId()
    if (generationId !== null && generationId !== previousGenerationId) return
    if (Date.now() > deadline) {
      throw new Error('The engine never returned to ready after a restart')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Section 18.5's twenty-five supervised restarts. Each cycle stops the engine
 * the way application shutdown does, proves the process is gone, starts a
 * fresh generation, and records how long the graceful stop took.
 */
async function runRestartSoak(): Promise<void> {
  const supervisor = engineSupervisor
  if (!supervisor) throw new Error('The supervisor was never created')

  const shutdownDurationsMs: number[] = []
  for (let restart = 1; restart <= RESTART_SOAK_COUNT; restart += 1) {
    if (liveEngineProcessCount() !== 1) {
      throw new Error(`Restart ${restart} did not begin with one live engine`)
    }

    const previousGenerationId = readyGenerationId()
    const startedAt = Date.now()
    const result = await supervisor.stop()
    const durationMs = Date.now() - startedAt
    shutdownDurationsMs.push(durationMs)

    if (result.outcome !== 'exited' || result.forced) {
      throw new Error(`Restart ${restart} did not shut down gracefully`)
    }
    if (liveEngineProcessCount() !== 0) {
      throw new Error(`Restart ${restart} left an engine process behind`)
    }
    if (durationMs > RESTART_SOAK_SHUTDOWN_LIMIT_MS) {
      throw new Error(`Restart ${restart} exceeded the shutdown deadline`)
    }

    // `restart()` is the crash-recovery path and is only accepted from a
    // stopped status. A supervised restart is the pair the application itself
    // uses: the graceful shutdown above, then a fresh supervised start.
    supervisor.start()
    await waitForEngineReady(
      RESTART_SOAK_READY_TIMEOUT_MS,
      previousGenerationId
    )
  }

  const ordered = [...shutdownDurationsMs].sort((left, right) => left - right)
  const percentile95 =
    ordered[
      Math.min(Math.ceil(0.95 * ordered.length) - 1, ordered.length - 1)
    ] ?? 0
  if (percentile95 > RESTART_SOAK_PERCENTILE_LIMIT_MS) {
    throw new Error('The 95th percentile shutdown exceeded two seconds')
  }

  if (smokeTimeout) clearTimeout(smokeTimeout)
  smokeTimeout = null
  console.log(
    JSON.stringify({
      engineProcessesAfterEachStop: 0,
      maximumShutdownMs: ordered.at(-1) ?? 0,
      percentile95ShutdownMs: percentile95,
      restarts: RESTART_SOAK_COUNT,
      result: 'pass',
      scenario: 'restart-soak'
    })
  )
  requestQuit(0)
}

function scheduleRestartSoak(): void {
  if (
    !isRestartSoak ||
    restartSoakStarted ||
    latestEngineStatusEvent.status.state !== 'ready'
  ) {
    return
  }
  restartSoakStarted = true
  void runRestartSoak().catch(error => {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message.slice(0, 256)
            : 'unknown restart-soak failure',
        result: 'fail',
        scenario: 'restart-soak'
      })
    )
    requestQuit(1)
  })
}

function isRendererOsSandboxed(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const rendererPid = mainWindow.webContents.getOSProcessId()
  return app
    .getAppMetrics()
    .some(metric => metric.pid === rendererPid && metric.sandboxed === true)
}

function scheduleSmokeCompletion(): void {
  scheduleSmokeIntervention()
  if (
    !isMilestoneSmoke ||
    !rendererBootstrapped ||
    !isSmokeScenarioComplete() ||
    smokeCompletionTimer ||
    smokeFinalizationStarted
  ) {
    return
  }

  smokeCompletionTimer = setTimeout(() => {
    smokeCompletionTimer = null
    if (!rendererBootstrapped || !isSmokeScenarioComplete()) return
    smokeFinalizationStarted = true
    void collectSmokeTrustEvidence()
      .then(evidence => {
        if (smokeTimeout) clearTimeout(smokeTimeout)
        smokeTimeout = null
        console.log(JSON.stringify(smokeResult(evidence)))
        requestQuit(0)
      })
      .catch(error => {
        console.error(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message.slice(0, 256)
                : 'unknown verification failure',
            rendererBootstrapped,
            result: 'trust-boundary-verification-failed',
            scenario: smokeScenario
          })
        )
        requestQuit(1)
      })
  }, SMOKE_COMPLETION_DELAY_MS)
}

function markRendererBootstrapped(trustProof: PreloadTrustProof): void {
  preloadTrustProof = trustProof
  rendererBootstrapped = true
  deliverPendingIntents()
  scheduleSmokeCompletion()
}

function createMainWindow(runtime: RuntimeInfo): BrowserWindow {
  if (!uiSession || !stateStore || !engineSupervisor) {
    throw new Error('Application services must exist before the main window')
  }

  const window = new BrowserWindow({
    backgroundColor: '#101418',
    minHeight: 560,
    minWidth: 760,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    ...restoredWindowBounds(),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: preloadFile(),
      session: uiSession
    }
  })
  mainWindow = window
  secureWindow(window, diagnostics, {
    onNavigationDenied: url => smokeNavigationDeniedObserver?.(url)
  })
  assertWindowSecurity(window, uiSession)

  unregisterDesktopIpc?.()
  /**
   * The only filesystem chooser in the application. Main opens it modally on
   * the owning window and returns exactly one user-selected path; the renderer
   * never enumerates the filesystem.
   */
  const chooseUserPath = async (
    owner: BrowserWindow,
    kind: 'application' | 'directory' | 'source' | 'subtitle' | 'torrent-file'
  ): Promise<{
    path: string | null
    summary: { fileCount: number; totalBytes: number } | null
  }> => {
    const properties: Array<'openDirectory' | 'openFile'> =
      kind === 'directory' ? ['openDirectory'] : ['openFile']
    if (kind === 'source') properties.push('openDirectory')

    const result = await dialog.showOpenDialog(owner, {
      filters:
        kind === 'torrent-file'
          ? [{ extensions: ['torrent'], name: 'Torrent' }]
          : kind === 'subtitle'
            ? [{ extensions: ['srt', 'vtt'], name: 'Subtitles' }]
            : [],
      properties,
      securityScopedBookmarks: false,
      ...(kind === 'subtitle' ? { title: 'Select a Subtitle File' } : {})
    })
    if (result.canceled) return { path: null, summary: null }
    const chosen = result.filePaths[0] ?? null
    if (chosen === null) return { path: null, summary: null }
    return {
      path: chosen,
      summary: kind === 'source' ? await measureSource(chosen) : null
    }
  }

  const externalPlayer = new ExternalPlayer({
    diagnostics,
    getMediaPort: () => {
      const status = engineSupervisor?.status()
      return status?.state === 'ready' ? status.mediaPort : null
    }
  })

  torrentHandlers = new TorrentHandlers({
    diagnostics,
    onIntent: intent => {
      // The renderer installs its intent listener during bootstrap. An intent
      // that arrives first is held rather than sent into a frame that cannot
      // yet receive it.
      if (!rendererBootstrapped) {
        if (pendingIntents.length < MAX_PENDING_ACTIVATIONS) {
          pendingIntents.push(intent)
        }
        return
      }
      window.webContents.mainFrame.send(DESKTOP_OPEN_INTENT_CHANNEL, {
        protocolVersion: PROTOCOL_VERSION,
        intent
      })
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })
  deliverPendingIntents = (): void => {
    const queued = pendingIntents.splice(0, pendingIntents.length)
    for (const intent of queued) {
      window.webContents.mainFrame.send(DESKTOP_OPEN_INTENT_CHANNEL, {
        protocolVersion: PROTOCOL_VERSION,
        intent
      })
    }
    if (queued.length === 0) return
    if (window.isMinimized()) window.restore()
    window.focus()
  }

  app.on('second-instance', (_event, argv) => {
    void torrentHandlers?.handleArguments(argv)
  })
  // Anything macOS delivered before the handlers existed is routed now, along
  // with the arguments this launch itself carried.
  drainPendingActivations()
  void torrentHandlers.handleArguments(process.argv)

  const sendMenuAction = (
    action: 'add-subtitles' | 'add-torrent' | 'create-torrent' | 'preferences'
  ): void => {
    window.webContents.mainFrame.send(DESKTOP_MENU_ACTION_CHANNEL, {
      protocolVersion: PROTOCOL_VERSION,
      action
    })
  }
  installAppMenu({
    actions: {
      addSubtitles: () => sendMenuAction('add-subtitles'),
      addTorrent: () => sendMenuAction('add-torrent'),
      createTorrent: () => sendMenuAction('create-torrent'),
      openPreferences: () => sendMenuAction('preferences'),
      quit: () => app.quit(),
      toggleFullScreen: () => window.setFullScreen(!window.isFullScreen())
    },
    developer: !app.isPackaged
  })

  // The watched folder is an explicit preference: enabling it starts one
  // watcher, clearing it stops the watcher entirely.
  const folderWatcher = new FolderWatcher({
    diagnostics,
    onTorrent: torrentPath => {
      routeActivation('file', torrentPath)
    }
  })
  const applyWatchPreference = (folder: string | null): void => {
    if (folder === null) {
      void folderWatcher.stop()
      return
    }
    if (folderWatcher.folder === folder) return
    void folderWatcher.watch(folder).catch(() => {
      diagnostics.warn('folder-watch.rejected')
    })
  }
  applyWatchPreference(
    stateStore?.snapshot().preferences.torrentsFolder ?? null
  )

  // The row's right-click menu is built, shown, and acted on entirely in main.
  const supervisor = engineSupervisor
  const contextMenu =
    stateStore && torrentLibrary && supervisor
      ? new TorrentContextMenu({
          buildMenu: template => {
            const menu = Menu.buildFromTemplate([...template])
            return { popup: () => menu.popup({ window }) }
          },
          copyText: text => clipboard.writeText(text),
          diagnostics,
          execute: operation => supervisor.execute(operation),
          library: torrentLibrary,
          payloadTrash: new PayloadTrash({ diagnostics }),
          revealPath: target => shell.showItemInFolder(target),
          stateStore
        })
      : null

  unregisterDesktopIpc = registerDesktopIpc({
    choosePath: kind => chooseUserPath(window, kind),
    diagnostics,
    exportTorrent: async infoHash => {
      const record = stateStore
        ?.listTorrents()
        .find(candidate => candidate.infoHash === infoHash)
      if (!record) throw new Error('The torrent is not in the library')

      const baseName = path.parse(path.basename(record.name)).name.trim()
      const fileName = `${baseName || record.infoHash}.torrent`
      const downloadRoot =
        stateStore?.snapshot().preferences.downloadRoot ??
        app.getPath('downloads')
      const save = await dialog.showSaveDialog(window, {
        buttonLabel: 'Save',
        defaultPath: path.join(downloadRoot, fileName),
        filters: [
          { extensions: ['torrent'], name: 'Torrent Files' },
          { extensions: ['*'], name: 'All Files' }
        ],
        securityScopedBookmarks: false,
        title: 'Save Torrent File'
      })
      if (save.canceled || !save.filePath) return false

      const result = await supervisor.execute({
        command: 'export-torrent',
        payload: { destinationPath: save.filePath, infoHash }
      })
      if (
        !result.ok ||
        result.result.command !== 'export-torrent' ||
        result.result.value.exported !== true
      ) {
        throw new Error('The torrent engine could not export the archive')
      }
      return true
    },
    ...(contextMenu
      ? { openTorrentMenu: (infoHash: string) => contextMenu.open(infoHash) }
      : {}),
    openExternalPlayer: async mediaUrl => {
      const configured = stateStore?.snapshot().preferences.externalPlayer
      if (!configured) throw new Error('No external player is configured')
      await externalPlayer.open({ mediaUrl, playerPath: configured })
    },
    onPreferencesChanged: preferences => {
      applyWatchPreference(preferences.torrentsFolder)
    },
    engineSupervisor,
    getEngineStatusEvent: () => structuredClone(latestEngineStatusEvent),
    onBootstrap: markRendererBootstrapped,
    runtime,
    stateStore,
    ...(torrentLibrary ? { torrentLibrary } : {}),
    window
  })

  window.on('move', () => {
    scheduleWindowBoundsSave(window)
  })
  window.on('resize', () => {
    scheduleWindowBoundsSave(window)
  })
  window.on('close', () => {
    if (window === mainWindow) persistWindowBounds(window)
  })
  window.on('closed', () => {
    if (window !== mainWindow) return
    if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer)
    windowBoundsSaveTimer = null
    unregisterDesktopIpc?.()
    unregisterDesktopIpc = null
    mainWindow = null
    rendererBootstrapped = false
    preloadTrustProof = null
  })
  window.once('ready-to-show', () => {
    if (!isMilestoneSmoke && !isRestartSoak && !shutdownStarted) window.show()
  })

  void window.loadURL(TRUSTED_RENDERER_URL).catch(() => {
    diagnostics.error('renderer.load-failed')
    requestQuit(1)
  })
  return window
}

async function initializeApplication(): Promise<void> {
  diagnostics.info('app.starting', {
    architecture: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node
  })

  stateStore = new AppStateStore(app.getPath('userData'), diagnostics)
  torrentLibrary = new TorrentLibrary({ diagnostics, stateStore })
  if (stateStore.snapshot().preferences.downloadRoot === null) {
    stateStore.setDownloadRoot(app.getPath('downloads'))
  }
  // The renderer's media-src names the engine's exact loopback port, so the
  // header is built from the live engine status rather than a fixed policy.
  uiSession = createUiSession(diagnostics, {
    getMediaPort: () => {
      const status = engineSupervisor?.status()
      return status?.state === 'ready' ? status.mediaPort : null
    }
  })
  unregisterApplicationProtocol = registerApplicationProtocol(
    uiSession,
    rendererRoot()
  )

  const runtime = runtimeInfo()
  const engineWorkingDirectory = path.join(app.getPath('userData'), 'engine')
  if (
    existsSync(engineWorkingDirectory) &&
    (lstatSync(engineWorkingDirectory).isSymbolicLink() ||
      !lstatSync(engineWorkingDirectory).isDirectory())
  ) {
    throw new Error('Torrent engine working path must be a real directory')
  }
  mkdirSync(engineWorkingDirectory, { mode: 0o700, recursive: true })
  chmodSync(engineWorkingDirectory, 0o700)
  // Live torrent activity drives macOS behavior: the Mac stays awake only
  // while transfers run, the dock shows a bounded count, and a finished
  // download notifies exactly once.
  const dockBadge = new DockBadge()
  const powerSaveGuard = new PowerSaveGuard({ diagnostics })
  const notifier = new DesktopNotifier({ diagnostics })
  const runningTorrents = new Map<string, boolean>()
  const notifiedComplete = new Set<string>()
  /** Torrents this session has actually seen short of complete. */
  const incompleteTorrents = new Set<string>()

  engineSupervisor = new EngineSupervisor({
    appVersion: runtime.appVersion,
    diagnostics,
    entryPath: engineFile(),
    getStateRevision: () => stateStore?.snapshot().revision ?? 0,
    onEvent: envelope => {
      const event = envelope.payload
      if (event.event === 'torrent-removed') {
        runningTorrents.delete(event.payload.infoHash)
        notifiedComplete.delete(event.payload.infoHash)
        incompleteTorrents.delete(event.payload.infoHash)
      } else if (event.event === 'torrent-updated') {
        const torrent = event.payload
        runningTorrents.set(
          torrent.infoHash,
          torrent.state === 'checking' || torrent.state === 'downloading'
        )
        const wasIncomplete = incompleteTorrents.has(torrent.infoHash)
        if (torrent.progress < 1) incompleteTorrents.add(torrent.infoHash)
        else incompleteTorrents.delete(torrent.infoHash)
        // Only a torrent this session watched finish is announced. A restored
        // library and a freshly created seed both arrive already complete, and
        // neither is a download that just completed.
        if (
          torrent.progress >= 1 &&
          wasIncomplete &&
          !notifiedComplete.has(torrent.infoHash)
        ) {
          notifiedComplete.add(torrent.infoHash)
          notifier.notify({ body: torrent.name, title: 'Download complete' })
        }
      } else {
        return
      }

      const running = [...runningTorrents.values()].filter(Boolean).length
      powerSaveGuard.update(running)
      dockBadge.set(running)
    },
    onStatus: publishEngineStatus,
    workingDirectory: engineWorkingDirectory
  })

  createMainWindow(runtime)
  engineSupervisor.start()

  if (isMilestoneSmoke || isRestartSoak) {
    smokeTimeout = setTimeout(
      () => {
        console.error(
          JSON.stringify({
            engine: latestEngineStatusEvent.status,
            rendererBootstrapped,
            result: 'timeout'
          })
        )
        requestQuit(1)
      },
      isRestartSoak ? RESTART_SOAK_TIMEOUT_MS : SMOKE_TIMEOUT_MS
    )
  }

  diagnostics.info('app.ready')
}

async function shutdownApplication(): Promise<void> {
  if (windowBoundsSaveTimer) clearTimeout(windowBoundsSaveTimer)
  if (smokeTimeout) clearTimeout(smokeTimeout)
  if (smokeCompletionTimer) clearTimeout(smokeCompletionTimer)
  if (smokeInterventionTimer) clearTimeout(smokeInterventionTimer)
  windowBoundsSaveTimer = null
  smokeTimeout = null
  smokeCompletionTimer = null
  smokeInterventionTimer = null

  persistWindowBounds()
  unregisterDesktopIpc?.()
  unregisterDesktopIpc = null
  const engineShutdown = await engineSupervisor?.stop()
  if (engineShutdown?.outcome === 'timed-out') {
    requestedExitCode = Math.max(requestedExitCode, 1)
    diagnostics.error('app.engine-shutdown-unconfirmed', {
      killAccepted: engineShutdown.killAccepted
    })
  }
  unregisterApplicationProtocol?.()
  unregisterApplicationProtocol = null
  diagnostics.info('app.stopped', {
    engineShutdown: engineShutdown?.outcome ?? 'not-started',
    exitCode: requestedExitCode
  })
  await diagnostics.flush()
}

function requestQuit(exitCode: number): void {
  requestedExitCode = Math.max(requestedExitCode, exitCode)
  process.exitCode = requestedExitCode
  app.quit()
}

app.on(
  'certificate-error',
  (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault()
    diagnostics.warn('security.certificate-denied')
    callback(false)
  }
)
app.on('child-process-gone', (_event, details) => {
  diagnostics.error('app.child-process-gone', {
    exitCode: details.exitCode,
    reason: details.reason,
    type: details.type
  })
})
app.on(
  'login',
  (
    event,
    _webContents,
    _authenticationResponseDetails,
    _authInfo,
    callback
  ) => {
    event.preventDefault()
    diagnostics.warn('security.authentication-denied')
    callback()
  }
)
app.on('before-quit', event => {
  if (shutdownStarted) {
    event.preventDefault()
    return
  }

  event.preventDefault()
  shutdownStarted = true
  void shutdownApplication()
    .catch(() => {
      requestedExitCode = Math.max(requestedExitCode, 1)
    })
    .finally(() => {
      app.exit(requestedExitCode)
    })
})
app.on('second-instance', () => {
  if (shutdownStarted || !mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
app.on('activate', () => {
  if (shutdownStarted || mainWindow || !stateStore || !engineSupervisor) {
    return
  }

  createMainWindow(runtimeInfo())
})
app.on('window-all-closed', () => {
  if (!shutdownStarted) requestQuit(0)
})

const dangerousLaunchSwitch = findDangerousLaunchSwitch(app.commandLine, {
  automationBuild: __WEBTORRENT_UPDATED_E2E_BUILD__
})

if (dangerousLaunchSwitch) {
  diagnostics.error('security.dangerous-launch-switch')
  void diagnostics.flush().finally(() => {
    try {
      cleanupSmokeData()
    } finally {
      app.exit(1)
    }
  })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app
    .whenReady()
    .then(initializeApplication)
    .catch(async () => {
      requestedExitCode = 1
      diagnostics.error('app.start-failed')
      await diagnostics.flush()
      app.exit(1)
    })
}
