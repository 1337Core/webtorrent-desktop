import type {
  BootstrapResult,
  EngineCommand,
  EngineStatus,
  RestartEngineResult,
  TorrentCommandResult
} from '../shared/contracts'

declare global {
  interface Window {
    desktop: {
      getBootstrap: () => Promise<BootstrapResult>
      onEngineStatus: (listener: (status: EngineStatus) => void) => () => void
      restartEngine: () => Promise<RestartEngineResult>
      runTorrentCommand: (
        operation: EngineCommand
      ) => Promise<TorrentCommandResult>
    }
  }
}

export {}
