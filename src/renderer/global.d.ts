import type {
  BootstrapResult,
  EngineStatus,
  RestartEngineResult
} from '../shared/contracts'

declare global {
  interface Window {
    desktop: {
      getBootstrap: () => Promise<BootstrapResult>
      onEngineStatus: (listener: (status: EngineStatus) => void) => () => void
      restartEngine: () => Promise<RestartEngineResult>
    }
  }
}

export {}
