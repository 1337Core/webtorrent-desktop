import { contextBridge, ipcRenderer } from 'electron'
import {
  APP_NAME,
  ENGINE_STATUS_CHANNEL,
  isEngineStatus,
  RENDERER_READY_CHANNEL,
  type EngineStatus,
  type RuntimeInfo
} from '../shared/contracts'

const runtimeInfo: RuntimeInfo = Object.freeze({
  appName: APP_NAME,
  appVersion: process.env.npm_package_version ?? '1.0.0-dev',
  architecture: process.arch,
  chromeVersion: process.versions.chrome,
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  platform: process.platform
})

contextBridge.exposeInMainWorld('webtorrentUpdated', {
  getRuntimeInfo: (): RuntimeInfo => runtimeInfo,
  reportRendererReady: (): void => {
    ipcRenderer.send(RENDERER_READY_CHANNEL)
  },
  onEngineStatus: (listener: (status: EngineStatus) => void): (() => void) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      value: unknown
    ): void => {
      if (isEngineStatus(value)) listener(value)
    }

    ipcRenderer.on(ENGINE_STATUS_CHANNEL, wrappedListener)
    return () =>
      ipcRenderer.removeListener(ENGINE_STATUS_CHANNEL, wrappedListener)
  }
})
