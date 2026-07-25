import type {
  BootstrapResult,
  ChoosePathResult,
  EngineCommand,
  EngineStatus,
  MenuActionEvent,
  OpenIntentEvent,
  RestartEngineResult,
  SetPreferencesResult,
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
      onMenuAction: (
        listener: (action: MenuActionEvent['action']) => void
      ) => () => void
      onOpenIntent: (
        listener: (intent: OpenIntentEvent['intent']) => void
      ) => () => void
      restartEngine: () => Promise<RestartEngineResult>
      runTorrentCommand: (
        operation: EngineCommand
      ) => Promise<TorrentCommandResult>
      setDownloadRoot: (downloadRoot: string) => Promise<SetPreferencesResult>
    }
  }
}

export {}
