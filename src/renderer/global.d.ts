import type { EngineStatus, RuntimeInfo } from '../shared/contracts'

declare global {
  interface Window {
    webtorrentUpdated: {
      getRuntimeInfo: () => RuntimeInfo
      onEngineStatus: (listener: (status: EngineStatus) => void) => () => void
      reportRendererReady: () => void
    }
  }
}

export {}
