import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import {
  APP_NAME,
  ENGINE_STATUS_CHANNEL,
  isEngineStatus,
  RENDERER_READY_CHANNEL,
  type EngineStatus
} from '../shared/contracts'

app.setName(APP_NAME)
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME))
app.enableSandbox()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let engineProcess: UtilityProcess | null = null
let lastEngineStatus: EngineStatus = { state: 'starting' }
let rendererReady = false
const isMilestoneSmoke = process.argv.includes('--m1-smoke')
let smokeTimeout: NodeJS.Timeout | null = null

function rendererRoot(): string {
  return path.join(__dirname, '..', 'renderer')
}

function preloadFile(): string {
  return path.join(__dirname, '..', 'preload', 'index.cjs')
}

function engineFile(): string {
  return path.join(__dirname, '..', 'engine', 'index.mjs')
}

function installApplicationProtocol(): void {
  protocol.handle('app', request => {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.hostname !== 'bundle') {
      return new Response(null, { status: 404 })
    }

    const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const root = rendererRoot()
    const resolvedPath = path.resolve(root, requestedPath || 'index.html')
    if (
      resolvedPath !== root &&
      !resolvedPath.startsWith(`${root}${path.sep}`)
    ) {
      return new Response(null, { status: 404 })
    }

    return net.fetch(pathToFileURL(resolvedPath).toString())
  })
}

function sendEngineStatus(status: EngineStatus): void {
  lastEngineStatus = status
  mainWindow?.webContents.send(ENGINE_STATUS_CHANNEL, status)
  finishMilestoneSmokeIfReady()
}

function finishMilestoneSmokeIfReady(): void {
  if (
    !isMilestoneSmoke ||
    !rendererReady ||
    lastEngineStatus.state !== 'ready'
  ) {
    return
  }

  if (smokeTimeout) clearTimeout(smokeTimeout)
  console.log(
    JSON.stringify({
      architecture: process.arch,
      electron: process.versions.electron,
      engine: lastEngineStatus,
      node: process.versions.node,
      renderer: 'ready',
      result: 'pass'
    })
  )
  app.exit(0)
}

function startEngine(): void {
  sendEngineStatus({ state: 'starting' })
  engineProcess = utilityProcess.fork(engineFile(), [], {
    serviceName: 'WebTorrent Updated Engine',
    stdio: 'pipe'
  })

  engineProcess.on('message', value => {
    if (isEngineStatus(value)) sendEngineStatus(value)
  })

  engineProcess.on('exit', code => {
    if (code !== 0 && lastEngineStatus.state !== 'failed') {
      sendEngineStatus({
        state: 'failed',
        message: `Torrent engine exited with code ${code}`
      })
    }
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    backgroundColor: '#101418',
    height: 720,
    minHeight: 560,
    minWidth: 760,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadFile(),
      sandbox: true,
      webSecurity: true
    },
    width: 1080
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://bundle/')) event.preventDefault()
  })
  window.webContents.on('did-finish-load', () => {
    window.webContents.send(ENGINE_STATUS_CHANNEL, lastEngineStatus)
  })
  window.once('ready-to-show', () => {
    if (!isMilestoneSmoke) window.show()
  })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  void window.loadURL('app://bundle/index.html')
  mainWindow = window
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(() => {
      installApplicationProtocol()
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => {
          callback(false)
        }
      )

      ipcMain.on(RENDERER_READY_CHANNEL, event => {
        if (event.sender !== mainWindow?.webContents) return
        rendererReady = true
        finishMilestoneSmokeIfReady()
      })

      createWindow()
      startEngine()

      if (isMilestoneSmoke) {
        smokeTimeout = setTimeout(() => {
          console.error(
            JSON.stringify({
              engine: lastEngineStatus,
              rendererReady,
              result: 'timeout'
            })
          )
          app.exit(1)
        }, 30_000)
      }

      app.on('activate', () => {
        if (!mainWindow) createWindow()
      })
    })
    .catch(error => {
      console.error('Failed to start WebTorrent Updated', error)
      app.quit()
    })

  app.on('before-quit', () => {
    engineProcess?.kill()
    engineProcess = null
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
