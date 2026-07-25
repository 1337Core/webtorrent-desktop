import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  ENGINE_STATUS_CHANNEL,
  PROTOCOL_VERSION,
  type BootstrapResult,
  type EngineStatus,
  type EngineStatusEvent,
  type RestartEngineResult
} from '../shared/contracts'

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    exposeInMainWorld: vi.fn(),
    invoke: vi.fn(),
    listeners,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener)
    }),
    removeListener: vi.fn(
      (channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      }
    )
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMock.exposeInMainWorld
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener
  }
}))

type DesktopApi = {
  getBootstrap: () => Promise<BootstrapResult>
  onEngineStatus: (listener: (status: EngineStatus) => void) => () => void
  restartEngine: () => Promise<RestartEngineResult>
}

const processPropertyNames = [
  'contextIsolated',
  'isMainFrame',
  'sandboxed'
] as const
const originalProcessProperties = new Map<
  string,
  PropertyDescriptor | undefined
>()

function setTrustedPreloadProcess(value: boolean): void {
  for (const name of processPropertyNames) {
    Object.defineProperty(process, name, {
      configurable: true,
      value,
      writable: true
    })
  }
}

async function loadApi(): Promise<DesktopApi> {
  vi.resetModules()
  electronMock.exposeInMainWorld.mockClear()
  electronMock.invoke.mockReset()
  electronMock.listeners.clear()
  electronMock.on.mockClear()
  electronMock.removeListener.mockClear()
  await import('./index')

  expect(electronMock.exposeInMainWorld).toHaveBeenCalledOnce()
  const [name, api] = electronMock.exposeInMainWorld.mock.calls[0] ?? []
  expect(name).toBe('desktop')
  return api as DesktopApi
}

function readyStatus(generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
  return {
    state: 'ready',
    generationId: generation,
    restartCount: 0,
    architecture: 'arm64',
    mediaPort: 52_000,
    electronVersion: '43.2.0',
    nodeVersion: '24.18.0',
    processType: 'utility',
    utpEnabled: false,
    webRtcSupported: true,
    webTorrentVersion: '3.0.16'
  } as const
}

function statusEvent(sequence: number, generation?: string): EngineStatusEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId:
      sequence % 2 === 0
        ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sequence,
    status: readyStatus(generation)
  }
}

function bootstrapSuccess(requestId: string, sequence = 0): BootstrapResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    ok: true,
    value: {
      protocolVersion: PROTOCOL_VERSION,
      engineStatusEvent: statusEvent(sequence),
      state: {
        schemaVersion: 1,
        revision: 0,
        preferences: { downloadRoot: null }
      },
      runtime: {
        appName: 'WebTorrent Updated',
        appVersion: '1.0.0-dev',
        architecture: 'arm64',
        chromeVersion: '142.0.7444.175',
        electronVersion: '43.2.0',
        nodeVersion: '24.18.0',
        platform: 'darwin'
      }
    }
  }
}

beforeAll(() => {
  for (const name of processPropertyNames) {
    originalProcessProperties.set(
      name,
      Object.getOwnPropertyDescriptor(process, name)
    )
  }
  setTrustedPreloadProcess(true)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  setTrustedPreloadProcess(true)
})

afterAll(() => {
  for (const name of processPropertyNames) {
    const descriptor = originalProcessProperties.get(name)
    if (descriptor) Object.defineProperty(process, name, descriptor)
    else Reflect.deleteProperty(process, name)
  }
})

describe('preload desktop bridge', () => {
  it('exposes exactly three frozen capabilities and validates bootstrap', async () => {
    const api = await loadApi()
    electronMock.invoke.mockImplementation(
      (
        channel: string,
        request: {
          payload: Record<string, unknown>
          requestId: string
        }
      ) => {
        expect(channel).toBe(DESKTOP_BOOTSTRAP_CHANNEL)
        expect(request.payload).toEqual({
          preloadTrustProof: {
            contextIsolated: true,
            isMainFrame: true,
            sandboxed: true
          }
        })
        return bootstrapSuccess(request.requestId)
      }
    )

    const result = await api.getBootstrap()

    expect(result).toMatchObject({ ok: true })
    expect(Object.keys(api).sort()).toEqual([
      'choosePath',
      'getBootstrap',
      'onEngineStatus',
      'onMenuAction',
      'restartEngine',
      'runTorrentCommand',
      'setDownloadRoot'
    ])
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('rejects a response with a mismatched request ID', async () => {
    const api = await loadApi()
    electronMock.invoke.mockImplementation(
      (_channel: string, _request: { requestId: string }) =>
        bootstrapSuccess('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    )

    const result = await api.getBootstrap()

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PROTOCOL_MISMATCH', retryable: false }
    })
  })

  it('returns a fixed timeout error when main does not answer', async () => {
    vi.useFakeTimers()
    const api = await loadApi()
    electronMock.invoke.mockReturnValue(new Promise(() => undefined))

    const resultPromise = api.getBootstrap()
    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      error: { code: 'REQUEST_TIMEOUT', retryable: true }
    })
  })

  it('closes the bootstrap/event race with the newest valid sequence', async () => {
    const api = await loadApi()
    const observed: EngineStatus[] = []
    api.onEngineStatus(status => observed.push(status))
    const listener = electronMock.listeners.get(ENGINE_STATUS_CHANNEL)
    listener?.({}, statusEvent(5, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
    electronMock.invoke.mockImplementation(
      (_channel: string, request: { requestId: string }) =>
        bootstrapSuccess(request.requestId, 4)
    )

    const result = await api.getBootstrap()

    expect(observed).toHaveLength(1)
    expect(result).toMatchObject({
      ok: true,
      value: {
        engineStatusEvent: {
          sequence: 5,
          status: {
            generationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
          }
        }
      }
    })
  })

  it('drops malformed and out-of-order events and unsubscribes once', async () => {
    const api = await loadApi()
    const listener = vi.fn()
    const unsubscribe = api.onEngineStatus(listener)
    const wrapped = electronMock.listeners.get(ENGINE_STATUS_CHANNEL)

    wrapped?.({}, statusEvent(2))
    wrapped?.({}, statusEvent(1))
    wrapped?.({}, { arbitrary: true })
    unsubscribe()
    unsubscribe()
    wrapped?.({}, statusEvent(3))

    expect(listener).toHaveBeenCalledOnce()
    expect(electronMock.removeListener).toHaveBeenCalledOnce()
  })

  it('refuses to expose IPC when preload isolation is not active', async () => {
    vi.resetModules()
    electronMock.exposeInMainWorld.mockClear()
    setTrustedPreloadProcess(false)

    await expect(import('./index')).rejects.toThrow(
      'Preload trust boundary verification failed'
    )
    expect(electronMock.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
