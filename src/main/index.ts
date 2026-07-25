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
  protocol,
  screen,
  type BrowserWindowConstructorOptions,
  type Rectangle,
  type Session
} from 'electron'
import { z } from 'zod'
import {
  APP_NAME,
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
import { AppStateStore } from './state-store'
import { TRUSTED_RENDERER_URL } from './trusted-renderer'

const DEFAULT_WINDOW_BOUNDS = {
  height: 720,
  width: 1080
} as const
const MINIMUM_VISIBLE_WINDOW_EDGE = 80
const WINDOW_BOUNDS_SAVE_DELAY_MS = 500
const SMOKE_TIMEOUT_MS = 40_000
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
const smokeDataRoot = isMilestoneSmoke ? mkdtempSync(SMOKE_DATA_PREFIX) : null
const rendererSmokeEvidenceSchema = z.strictObject({
  bootstrapCommitted: z.literal(true),
  bufferPresent: z.literal(false),
  desktopApiKeys: z.tuple([
    z.literal('getBootstrap'),
    z.literal('onEngineStatus'),
    z.literal('restartEngine')
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

app.setName(APP_NAME)
if (smokeDataRoot) app.setPath('appData', smokeDataRoot)
const userDataPath = path.join(app.getPath('appData'), APP_NAME)
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
let engineSupervisor: EngineSupervisor | null = null
let unregisterApplicationProtocol: (() => void) | null = null
let unregisterDesktopIpc: (() => void) | null = null
let windowBoundsSaveTimer: NodeJS.Timeout | null = null
let smokeTimeout: NodeJS.Timeout | null = null
let smokeCompletionTimer: NodeJS.Timeout | null = null
let smokeInterventionTimer: NodeJS.Timeout | null = null
let smokeForcedCrashes = 0
let smokeFinalizationStarted = false
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

function publishEngineStatus(status: EngineStatus): void {
  if (status.state === 'ready') lastReadyEngineStatus = status
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
        const root = document.querySelector('main')
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
  unregisterDesktopIpc = registerDesktopIpc({
    diagnostics,
    engineSupervisor,
    getEngineStatusEvent: () => structuredClone(latestEngineStatusEvent),
    onBootstrap: markRendererBootstrapped,
    runtime,
    stateStore,
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
    if (!isMilestoneSmoke && !shutdownStarted) window.show()
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
  if (stateStore.snapshot().preferences.downloadRoot === null) {
    stateStore.setDownloadRoot(app.getPath('downloads'))
  }
  uiSession = createUiSession(diagnostics)
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
  engineSupervisor = new EngineSupervisor({
    appVersion: runtime.appVersion,
    diagnostics,
    entryPath: engineFile(),
    getStateRevision: () => stateStore?.snapshot().revision ?? 0,
    onStatus: publishEngineStatus,
    workingDirectory: engineWorkingDirectory
  })

  createMainWindow(runtime)
  engineSupervisor.start()

  if (isMilestoneSmoke) {
    smokeTimeout = setTimeout(() => {
      console.error(
        JSON.stringify({
          engine: latestEngineStatusEvent.status,
          rendererBootstrapped,
          result: 'timeout'
        })
      )
      requestQuit(1)
    }, SMOKE_TIMEOUT_MS)
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

const dangerousLaunchSwitch = findDangerousLaunchSwitch(app.commandLine)

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
