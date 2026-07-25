import type {
  BootstrapResult,
  ChoosePathResult,
  EngineCommand,
  EngineStatus,
  ExternalPlayerResult,
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
        kind: 'application' | 'directory' | 'source' | 'torrent-file'
      ) => Promise<ChoosePathResult>
      getBootstrap: () => Promise<BootstrapResult>
      openExternalPlayer: (mediaUrl: string) => Promise<ExternalPlayerResult>
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
      setPreferences: (
        update: Readonly<{
          downloadRoot?: string
          externalPlayer?: string | null
          torrentsFolder?: string | null
        }>
      ) => Promise<SetPreferencesResult>
    }
  }
}

export {}
