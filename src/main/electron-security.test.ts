import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostics } from './diagnostics'

const electronMock = vi.hoisted(() => ({
  appendSwitch: vi.fn(),
  getSwitchValue: vi.fn(),
  isReady: vi.fn(),
  fromPartition: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    commandLine: {
      appendSwitch: electronMock.appendSwitch,
      getSwitchValue: electronMock.getSwitchValue
    },
    isReady: electronMock.isReady
  },
  net: {
    fetch: vi.fn()
  },
  session: {
    fromPartition: electronMock.fromPartition
  }
}))

import {
  RENDERER_CONNECTION_ALLOWLIST,
  RENDERER_WEBRTC_BLOCK_PROBE,
  SECURE_WEB_PREFERENCES,
  UI_SESSION_PARTITION,
  assertRendererWebRtcBlocked,
  configureRendererWebRtcBlocking,
  createUiSession,
  secureWebContents
} from './electron-security'

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

function createSessionHarness() {
  const handlers = {
    beforeRequest: undefined as
      | ((
          details: unknown,
          callback: (result: { cancel: boolean }) => void
        ) => void)
      | undefined,
    devicePermission: undefined as (() => boolean) | undefined,
    displayMedia: undefined as
      | ((
          request: unknown,
          callback: (streams: Record<string, never>) => void
        ) => void)
      | undefined,
    headersReceived: undefined as
      | ((
          details: { responseHeaders?: Record<string, string[]> },
          callback: (result: {
            responseHeaders: Record<string, string[]>
          }) => void
        ) => void)
      | undefined,
    permissionCheck: undefined as (() => boolean) | undefined,
    permissionRequest: undefined as
      | ((
          contents: unknown,
          permission: string,
          callback: (granted: boolean) => void
        ) => void)
      | undefined,
    willDownload: undefined as
      ((event: { preventDefault: () => void }) => void) | undefined
  }
  const session = {
    on: vi.fn((event: string, listener: typeof handlers.willDownload) => {
      if (event === 'will-download') handlers.willDownload = listener
    }),
    setDevicePermissionHandler: vi.fn((handler: () => boolean) => {
      handlers.devicePermission = handler
    }),
    setDisplayMediaRequestHandler: vi.fn(
      (handler: NonNullable<typeof handlers.displayMedia>) => {
        handlers.displayMedia = handler
      }
    ),
    setPermissionCheckHandler: vi.fn((handler: () => boolean) => {
      handlers.permissionCheck = handler
    }),
    setPermissionRequestHandler: vi.fn(
      (handler: NonNullable<typeof handlers.permissionRequest>) => {
        handlers.permissionRequest = handler
      }
    ),
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          _filter: unknown,
          handler: NonNullable<typeof handlers.beforeRequest>
        ) => {
          handlers.beforeRequest = handler
        }
      ),
      onHeadersReceived: vi.fn(
        (
          _filter: unknown,
          handler: NonNullable<typeof handlers.headersReceived>
        ) => {
          handlers.headersReceived = handler
        }
      )
    }
  }
  electronMock.fromPartition.mockReturnValue(session)
  return { handlers, session }
}

beforeEach(() => {
  vi.clearAllMocks()
  electronMock.getSwitchValue.mockReturnValue('')
  electronMock.isReady.mockReturnValue(false)
})

describe('secure Electron configuration', () => {
  it('pins the renderer to the final least-privilege preferences', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
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
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false
    })
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true)
  })

  it('creates a nonpersistent session that denies permissions and egress', () => {
    const { handlers, session } = createSessionHarness()
    const log = diagnostics()

    expect(createUiSession(log)).toBe(session)
    expect(electronMock.fromPartition).toHaveBeenCalledWith(
      UI_SESSION_PARTITION,
      { cache: false }
    )
    expect(handlers.permissionCheck?.()).toBe(false)
    expect(handlers.devicePermission?.()).toBe(false)

    const permissionCallback = vi.fn()
    handlers.permissionRequest?.({}, 'camera', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)

    const downloadEvent = { preventDefault: vi.fn() }
    handlers.willDownload?.(downloadEvent)
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce()

    const requestCallback = vi.fn()
    handlers.beforeRequest?.({}, requestCallback)
    expect(requestCallback).toHaveBeenCalledWith({ cancel: true })
  })

  it('reasserts response security headers at the session boundary', () => {
    const { handlers } = createSessionHarness()
    createUiSession(diagnostics())
    const callback = vi.fn()

    handlers.headersReceived?.(
      {
        responseHeaders: {
          'Content-Type': ['text/html']
        }
      },
      callback
    )

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: expect.objectContaining({
        'Content-Security-Policy': [
          expect.stringContaining("default-src 'none'")
        ],
        'Connection-Allowlist': [RENDERER_CONNECTION_ALLOWLIST],
        'Content-Type': ['text/html'],
        'Permissions-Policy': [expect.stringContaining('camera=()')],
        'X-DNS-Prefetch-Control': ['off'],
        'X-Content-Type-Options': ['nosniff']
      })
    })
  })
})

describe('renderer WebRTC egress policy', () => {
  it('enables the Chromium browser-process policy gate before readiness', () => {
    electronMock.getSwitchValue.mockImplementation((switchName: string) =>
      switchName === 'enable-features' ? 'ExistingFeature' : ''
    )

    configureRendererWebRtcBlocking()

    expect(electronMock.appendSwitch).toHaveBeenCalledWith(
      'enable-features',
      'ExistingFeature,OverrideConnectionAllowlistOriginTrial'
    )
  })

  it('does not duplicate an existing policy gate', () => {
    electronMock.getSwitchValue.mockImplementation((switchName: string) =>
      switchName === 'enable-features'
        ? 'OverrideConnectionAllowlistOriginTrial'
        : ''
    )

    configureRendererWebRtcBlocking()

    expect(electronMock.appendSwitch).not.toHaveBeenCalled()
  })

  it.each(['ConnectionAllowlists', 'OverrideConnectionAllowlistOriginTrial'])(
    'rejects a launch that disables %s',
    disabledFeature => {
      electronMock.getSwitchValue.mockImplementation((switchName: string) =>
        switchName === 'disable-features' ? disabledFeature : ''
      )

      expect(() => configureRendererWebRtcBlocking()).toThrow(
        'renderer network policy disabled'
      )
    }
  )

  it('rejects configuration after Electron readiness', () => {
    electronMock.isReady.mockReturnValue(true)

    expect(() => configureRendererWebRtcBlocking()).toThrow(
      'before Electron is ready'
    )
  })

  it('probes both supported renderer blocking outcomes', () => {
    expect(runInNewContext(RENDERER_WEBRTC_BLOCK_PROBE, {})).toMatchObject({
      outcome: 'api-unavailable'
    })

    function BlockedPeerConnection(): never {
      const error = new Error('blocked')
      error.name = 'NotAllowedError'
      throw error
    }
    expect(
      runInNewContext(RENDERER_WEBRTC_BLOCK_PROBE, {
        RTCPeerConnection: BlockedPeerConnection
      })
    ).toMatchObject({
      errorName: 'NotAllowedError',
      outcome: 'policy-blocked'
    })
  })

  it('fails the packaged assertion if construction is possible', async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValue({ outcome: 'constructor-succeeded' })

    await expect(
      assertRendererWebRtcBlocked({ executeJavaScript } as never)
    ).rejects.toThrow('egress policy is not active')
    expect(executeJavaScript).toHaveBeenCalledWith(
      RENDERER_WEBRTC_BLOCK_PROBE,
      false
    )
  })

  it('accepts the packaged assertion when Chromium blocks construction', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue({
      errorName: 'NotAllowedError',
      outcome: 'policy-blocked'
    })

    await expect(
      assertRendererWebRtcBlocked({ executeJavaScript } as never)
    ).resolves.toEqual({
      errorName: 'NotAllowedError',
      outcome: 'policy-blocked'
    })
  })
})

describe('secureWebContents', () => {
  it('denies popups, webviews, redirects, and untrusted navigation', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const mainFrame = {}
    const contents = {
      mainFrame,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
      }),
      setWebRTCIPHandlingPolicy: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    secureWebContents(contents as never, diagnostics())

    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp'
    )
    const popupHandler = contents.setWindowOpenHandler.mock.calls[0]?.[0]
    expect(popupHandler?.()).toEqual({ action: 'deny' })

    for (const eventName of ['will-attach-webview', 'will-redirect']) {
      const event = { preventDefault: vi.fn() }
      listeners.get(eventName)?.(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }

    const untrustedNavigation = {
      frame: mainFrame,
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: 'https://example.com'
    }
    listeners.get('will-frame-navigate')?.(untrustedNavigation)
    expect(untrustedNavigation.preventDefault).toHaveBeenCalledOnce()

    const untrustedMainNavigation = {
      preventDefault: vi.fn(),
      url: 'https://example.com'
    }
    listeners.get('will-navigate')?.(untrustedMainNavigation)
    expect(untrustedMainNavigation.preventDefault).toHaveBeenCalledOnce()

    const trustedNavigation = {
      frame: mainFrame,
      isMainFrame: true,
      preventDefault: vi.fn(),
      url: 'app://bundle/index.html#same-document'
    }
    listeners.get('will-frame-navigate')?.(trustedNavigation)
    expect(trustedNavigation.preventDefault).not.toHaveBeenCalled()

    const trustedMainNavigation = {
      preventDefault: vi.fn(),
      url: 'app://bundle/index.html'
    }
    listeners.get('will-navigate')?.(trustedMainNavigation)
    expect(trustedMainNavigation.preventDefault).not.toHaveBeenCalled()
  })
})
