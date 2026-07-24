export const APP_NAME = 'WebTorrent Updated'
export const ENGINE_STATUS_CHANNEL = 'engine:status'
export const RENDERER_READY_CHANNEL = 'renderer:ready'

export interface RuntimeInfo {
  appName: string
  appVersion: string
  chromeVersion: string
  electronVersion: string
  nodeVersion: string
  platform: NodeJS.Platform
  architecture: string
}

export type EngineStatus =
  | {
      state: 'starting'
    }
  | {
      state: 'ready'
      architecture: string
      electronVersion: string
      nodeVersion: string
      processType: string
      utpEnabled: boolean
      webRtcSupported: boolean
      webTorrentVersion: string
    }
  | {
      state: 'failed'
      message: string
    }

export function isEngineStatus(value: unknown): value is EngineStatus {
  if (!value || typeof value !== 'object' || !('state' in value)) return false

  const state = value.state
  if (state === 'starting') return true

  if (state === 'failed') {
    return 'message' in value && typeof value.message === 'string'
  }

  return (
    state === 'ready' &&
    'architecture' in value &&
    typeof value.architecture === 'string' &&
    'electronVersion' in value &&
    typeof value.electronVersion === 'string' &&
    'nodeVersion' in value &&
    typeof value.nodeVersion === 'string' &&
    'processType' in value &&
    typeof value.processType === 'string' &&
    'utpEnabled' in value &&
    typeof value.utpEnabled === 'boolean' &&
    'webRtcSupported' in value &&
    typeof value.webRtcSupported === 'boolean' &&
    'webTorrentVersion' in value &&
    typeof value.webTorrentVersion === 'string'
  )
}
