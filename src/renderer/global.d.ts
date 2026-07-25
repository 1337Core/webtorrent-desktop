import type {
  BootstrapResult,
  ChoosePathResult,
  EngineCommand,
  EngineStatus,
  RestartEngineResult,
  TorrentCommandResult
} from '../shared/contracts'

declare global {
  interface Window {
    desktop: {
      choosePath: (
        kind: 'directory' | 'source' | 'torrent-file'
      ) => Promise<ChoosePathResult>
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
