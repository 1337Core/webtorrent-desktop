import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  PROTOCOL_VERSION,
  type EngineStatusEvent,
  type RuntimeInfo
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { EngineSupervisor } from './engine-supervisor'
import { registerDesktopIpc } from './desktop-ipc'
import type { AppStateStore } from './state-store'

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const generationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Handler = (event: unknown, value: unknown) => unknown

function createHarness(): {
  cleanup: () => void
  diagnostics: Diagnostics
  engineSupervisor: EngineSupervisor
  event: unknown
  handlers: Map<string, Handler>
  onBootstrap: ReturnType<typeof vi.fn>
} {
  const handlers = new Map<string, Handler>()
  const frameIpc = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
  const frame = {
    detached: false,
    ipc: frameIpc,
    isDestroyed: () => false,
    url: 'app://bundle/index.html'
  }
  const webContents = {
    isDestroyed: () => false,
    mainFrame: frame
  }
  const window = {
    isDestroyed: () => false,
    webContents
  }
  const event = {
    sender: webContents,
    senderFrame: frame
  }
  const diagnostics = {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
  const readyStatus = {
    state: 'ready',
    generationId,
    restartCount: 0,
    architecture: 'arm64',
    electronVersion: '43.2.0',
    nodeVersion: '24.18.0',
    processType: 'utility',
    utpEnabled: false,
    webRtcSupported: true,
    webTorrentVersion: '3.0.16'
  } as const
  const engineSupervisor = {
    restart: vi.fn(() => true),
    status: vi.fn(() => readyStatus)
  } as unknown as EngineSupervisor
  const statusEvent: EngineStatusEvent = {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    sequence: 9,
    status: readyStatus
  }
  const runtime: RuntimeInfo = {
    appName: 'WebTorrent Updated',
    appVersion: '1.0.0-dev',
    architecture: 'arm64',
    chromeVersion: '142.0.7444.175',
    electronVersion: '43.2.0',
    nodeVersion: '24.18.0',
    platform: 'darwin'
  }
  const stateStore = {
    snapshot: () => ({
      schemaVersion: 1,
      revision: 4,
      preferences: {},
      window: { main: { normalBounds: null } }
    })
  } as unknown as AppStateStore
  const onBootstrap = vi.fn()
  const cleanup = registerDesktopIpc({
    diagnostics,
    engineSupervisor,
    getEngineStatusEvent: () => statusEvent,
    onBootstrap,
    runtime,
    stateStore,
    window: window as never
  })

  return {
    cleanup,
    diagnostics,
    engineSupervisor,
    event,
    handlers,
    onBootstrap
  }
}

function request(command: 'bootstrap' | 'restartEngine'): {
  command: 'bootstrap' | 'restartEngine'
  payload:
    | Record<string, never>
    | {
        preloadTrustProof: {
          contextIsolated: true
          isMainFrame: true
          sandboxed: true
        }
      }
  protocolVersion: 1
  requestId: string
} {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    command,
    payload:
      command === 'bootstrap'
        ? {
            preloadTrustProof: {
              contextIsolated: true,
              isMainFrame: true,
              sandboxed: true
            }
          }
        : {}
  }
}

describe('registerDesktopIpc', () => {
  it('returns a bounded main-owned bootstrap snapshot', async () => {
    const { event, handlers, onBootstrap } = createHarness()
    const handler = handlers.get(DESKTOP_BOOTSTRAP_CHANNEL)
    const result = await handler?.(event, request('bootstrap'))

    expect(result).toMatchObject({
      ok: true,
      requestId,
      value: {
        protocolVersion: PROTOCOL_VERSION,
        engineStatusEvent: { sequence: 9 },
        state: { revision: 4, schemaVersion: 1 },
        runtime: {
          appName: 'WebTorrent Updated',
          architecture: 'arm64'
        }
      }
    })
    expect(onBootstrap).toHaveBeenCalledWith({
      contextIsolated: true,
      isMainFrame: true,
      sandboxed: true
    })
  })

  it('rejects untrusted frames before parsing their payload', async () => {
    const { diagnostics, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_BOOTSTRAP_CHANNEL)
    const untrustedEvent = {
      ...(event as Record<string, unknown>),
      senderFrame: {
        detached: false,
        isDestroyed: () => false,
        url: 'https://example.com'
      }
    }
    const result = await handler?.(untrustedEvent, request('bootstrap'))

    expect(result).toMatchObject({
      ok: false,
      requestId: null,
      error: { code: 'UNAUTHORIZED_SENDER', retryable: false }
    })
    expect(diagnostics.warn).toHaveBeenCalledWith('ipc.unauthorized')
  })

  it('rejects oversized, malformed, and duplicate requests', async () => {
    const { event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_BOOTSTRAP_CHANNEL)

    expect(
      await handler?.(event, {
        ...request('bootstrap'),
        oversized: 'x'.repeat(5000)
      })
    ).toMatchObject({
      ok: false,
      requestId,
      error: { code: 'PAYLOAD_TOO_LARGE' }
    })
    expect(
      await handler?.(event, {
        ...request('bootstrap'),
        command: 'arbitrary'
      })
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })

    expect(await handler?.(event, request('bootstrap'))).toMatchObject({
      ok: true
    })
    expect(await handler?.(event, request('bootstrap'))).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_REQUEST' }
    })
  })

  it('accepts only a restart from the supervisor stopped state', async () => {
    const { engineSupervisor, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_ENGINE_RESTART_CHANNEL)

    expect(await handler?.(event, request('restartEngine'))).toMatchObject({
      ok: true,
      value: { accepted: true, status: { state: 'ready' } }
    })

    vi.mocked(engineSupervisor.restart).mockReturnValue(false)
    const secondRequest = {
      ...request('restartEngine'),
      requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    }
    expect(await handler?.(event, secondRequest)).toMatchObject({
      ok: false,
      error: { code: 'ENGINE_UNAVAILABLE', retryable: true }
    })
  })

  it('removes both private frame handlers during cleanup', () => {
    const { cleanup, handlers } = createHarness()

    cleanup()

    expect(handlers.size).toBe(0)
  })
})
