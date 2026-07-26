import {
  app,
  session,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'
import {
  buildApplicationCsp,
  RENDERER_CONNECTION_ALLOWLIST
} from './application-protocol'
import type { Diagnostics } from './diagnostics'
import { isTrustedApplicationUrl } from './trusted-renderer'

export const UI_SESSION_PARTITION = 'webtorrent-updated-ui'
export { RENDERER_CONNECTION_ALLOWLIST } from './application-protocol'

const CONNECTION_ALLOWLIST_OVERRIDE_FEATURE =
  'OverrideConnectionAllowlistOriginTrial'
const CONNECTION_ALLOWLIST_KILL_SWITCH = 'ConnectionAllowlists'

export type RendererWebRtcBlockProof =
  | Readonly<{ outcome: 'api-unavailable' }>
  | Readonly<{ outcome: 'policy-blocked'; errorName: 'NotAllowedError' }>

type SecurityObserver = {
  onNavigationDenied?: (url: string) => void
}

export const RENDERER_WEBRTC_BLOCK_PROBE = `(() => {
  const PeerConnection = globalThis.RTCPeerConnection
  if (typeof PeerConnection !== 'function') {
    return { outcome: 'api-unavailable' }
  }

  try {
    const peer = new PeerConnection({
      iceServers: [{ urls: 'stun:127.0.0.1:9' }]
    })
    peer.close()
    return { outcome: 'constructor-succeeded' }
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && 'name' in error
        ? String(error.name)
        : 'UnknownError'
    return errorName === 'NotAllowedError'
      ? { outcome: 'policy-blocked', errorName }
      : { outcome: 'unexpected-error', errorName }
  }
})()`

export const SECURE_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  allowRunningInsecureContent: false,
  autoplayPolicy: 'document-user-activation-required',
  contextIsolation: true,
  devTools: false,
  disableDialogs: true,
  enableWebSQL: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  plugins: false,
  safeDialogs: true,
  sandbox: true,
  spellcheck: false,
  webSecurity: true,
  webviewTag: false
})

function featureListIncludes(value: string, expected: string): boolean {
  return value.split(',').some(entry => {
    const featureName = entry.trim().split(/[<:]/u, 1)[0]
    return featureName === expected
  })
}

/**
 * Enables Chromium's browser-process gate for Connection-Allowlist response
 * headers. Electron 43's Chromium build requires this explicit override because
 * the feature is otherwise origin-trial gated. Call before app readiness.
 */
export function configureRendererWebRtcBlocking(): void {
  if (app.isReady()) {
    throw new Error(
      'Renderer WebRTC blocking must be configured before Electron is ready'
    )
  }

  const disabledFeatures = app.commandLine.getSwitchValue('disable-features')
  if (
    featureListIncludes(
      disabledFeatures,
      CONNECTION_ALLOWLIST_OVERRIDE_FEATURE
    ) ||
    featureListIncludes(disabledFeatures, CONNECTION_ALLOWLIST_KILL_SWITCH)
  ) {
    throw new Error(
      'Electron was launched with the renderer network policy disabled'
    )
  }

  const enabledFeatures = app.commandLine.getSwitchValue('enable-features')
  if (
    !featureListIncludes(enabledFeatures, CONNECTION_ALLOWLIST_OVERRIDE_FEATURE)
  ) {
    app.commandLine.appendSwitch(
      'enable-features',
      [enabledFeatures, CONNECTION_ALLOWLIST_OVERRIDE_FEATURE]
        .filter(Boolean)
        .join(',')
    )
  }
}

/**
 * Exactly the engine's current loopback media origin, and nothing else. The
 * port has to match the one the engine reported, so a stale or guessed port is
 * refused along with every other host, scheme, and credential form.
 */
function isEngineMediaRequest(url: string, mediaPort: number | null): boolean {
  if (
    mediaPort === null ||
    !Number.isSafeInteger(mediaPort) ||
    mediaPort < 1 ||
    mediaPort > 65_535
  ) {
    return false
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'http:' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.port === String(mediaPort) &&
    parsed.username === '' &&
    parsed.password === ''
  )
}

export type UiSessionOptions = Readonly<{
  /** The engine's loopback media port, or null before it reports one. */
  getMediaPort?: () => number | null
}>

export function createUiSession(
  diagnostics: Diagnostics,
  options: UiSessionOptions = {}
): Session {
  const getMediaPort = options.getMediaPort ?? ((): number | null => null)
  const uiSession = session.fromPartition(UI_SESSION_PARTITION, {
    cache: false
  })

  uiSession.setPermissionCheckHandler(() => false)
  uiSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      diagnostics.warn('security.permission-denied')
      callback(false)
    }
  )
  uiSession.setDevicePermissionHandler(() => false)
  uiSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({})
  })
  uiSession.on('will-download', event => {
    event.preventDefault()
    diagnostics.warn('security.download-denied')
  })
  uiSession.webRequest.onBeforeRequest(
    {
      urls: ['file://*/*', 'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']
    },
    (details, callback) => {
      // The player's media and artwork are served by the engine's own loopback
      // proxy, which the CSP already names. Exactly that origin is allowed
      // through; everything else the renderer attempts is still denied.
      if (isEngineMediaRequest(details.url, getMediaPort())) {
        callback({})
        return
      }
      diagnostics.warn('security.renderer-network-denied')
      callback({ cancel: true })
    }
  )
  uiSession.webRequest.onHeadersReceived(
    { urls: ['app://bundle/*'] },
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Connection-Allowlist': [RENDERER_CONNECTION_ALLOWLIST],
          'Content-Security-Policy': [buildApplicationCsp(getMediaPort())],
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Permissions-Policy': [
            'camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(self), payment=(), usb=()'
          ],
          'Referrer-Policy': ['no-referrer'],
          'X-DNS-Prefetch-Control': ['off'],
          'X-Content-Type-Options': ['nosniff']
        }
      })
    }
  )

  return uiSession
}

export async function assertRendererWebRtcBlocked(
  contents: Pick<WebContents, 'executeJavaScript'>
): Promise<RendererWebRtcBlockProof> {
  const result: unknown = await contents.executeJavaScript(
    RENDERER_WEBRTC_BLOCK_PROBE,
    false
  )

  if (
    result &&
    typeof result === 'object' &&
    'outcome' in result &&
    result.outcome === 'api-unavailable'
  ) {
    return { outcome: 'api-unavailable' }
  }
  if (
    result &&
    typeof result === 'object' &&
    'outcome' in result &&
    result.outcome === 'policy-blocked' &&
    'errorName' in result &&
    result.errorName === 'NotAllowedError'
  ) {
    return {
      outcome: 'policy-blocked',
      errorName: 'NotAllowedError'
    }
  }

  throw new Error('Renderer WebRTC egress policy is not active')
}

export function secureWebContents(
  contents: WebContents,
  diagnostics: Diagnostics,
  observer: SecurityObserver = {}
): void {
  const setWebRtcIpHandlingPolicy = (
    contents as WebContents & {
      setWebRTCIPHandlingPolicy?: (policy: string) => void
    }
  ).setWebRTCIPHandlingPolicy
  if (!setWebRtcIpHandlingPolicy) {
    throw new Error('Electron cannot enforce the renderer WebRTC IP policy')
  }
  setWebRtcIpHandlingPolicy.call(contents, 'disable_non_proxied_udp')
  contents.setWindowOpenHandler(() => {
    diagnostics.warn('security.popup-denied')
    return { action: 'deny' }
  })

  contents.on('will-attach-webview', event => {
    event.preventDefault()
    diagnostics.warn('security.webview-denied')
  })
  contents.on('will-frame-navigate', event => {
    if (
      !event.isMainFrame ||
      event.frame !== contents.mainFrame ||
      !isTrustedApplicationUrl(event.url)
    ) {
      event.preventDefault()
      observer.onNavigationDenied?.(event.url)
      diagnostics.warn('security.navigation-denied')
    }
  })
  contents.on('will-navigate', event => {
    if (!isTrustedApplicationUrl(event.url)) {
      event.preventDefault()
      observer.onNavigationDenied?.(event.url)
      diagnostics.warn('security.navigation-denied')
    }
  })
  contents.on('will-redirect', event => {
    event.preventDefault()
    diagnostics.warn('security.redirect-denied')
  })
  contents.on('will-prevent-unload', event => {
    event.preventDefault()
  })
  contents.on('preload-error', (_event, _preloadPath, error) => {
    diagnostics.error('renderer.preload-error', { error })
  })
  contents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      diagnostics.error('renderer.did-fail-load', { errorCode })
    }
  )
  contents.on('render-process-gone', (_event, details) => {
    diagnostics.error('renderer.process-gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  contents.on('unresponsive', () => {
    diagnostics.warn('renderer.unresponsive')
  })
}

export function secureWindow(
  window: BrowserWindow,
  diagnostics: Diagnostics,
  observer: SecurityObserver = {}
): void {
  secureWebContents(window.webContents, diagnostics, observer)
  window.on('page-title-updated', event => {
    event.preventDefault()
  })
}
