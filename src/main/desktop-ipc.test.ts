import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BOOTSTRAP_CHANNEL,
  DESKTOP_CHOOSE_PATH_CHANNEL,
  DESKTOP_CONTEXT_MENU_CHANNEL,
  DESKTOP_ENGINE_RESTART_CHANNEL,
  DESKTOP_EXPORT_TORRENT_CHANNEL,
  DESKTOP_TORRENT_COMMAND_CHANNEL,
  PROTOCOL_VERSION,
  type EngineStatusEvent,
  type RuntimeInfo
} from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { EngineSupervisor } from './engine-supervisor'
import { registerDesktopIpc } from './desktop-ipc'
import type { AppStateStore } from './state-store'
import type { ExternalSubtitleGrant } from '../shared/engine-api'

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const generationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const subtitleGrant: ExternalSubtitleGrant = {
  canonicalPath: '/Users/owner/captions.vtt',
  file: {
    device: '1',
    inode: '2',
    modifiedNs: '3',
    size: '4'
  },
  parentChain: [
    { device: '1', inode: '5', path: '/Users' },
    { device: '1', inode: '6', path: '/Users/owner' }
  ]
}

type Handler = (event: unknown, value: unknown) => unknown

function createHarness(
  options: {
    chosenPath?: string
    chosenSummary?: { fileCount: number; totalBytes: number }
    exportTorrent?: (infoHash: string) => Promise<boolean>
    openTorrentMenu?: (infoHash: string) => boolean
    stateRevision?: number
  } = {}
): {
  choosePath: ReturnType<typeof vi.fn>
  cleanup: () => void
  diagnostics: Diagnostics
  engineSupervisor: EngineSupervisor
  exportTorrent: ReturnType<typeof vi.fn>
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
    audioMetadataParser: 'music-metadata.parseStream',
    mediaPort: 52_000,
    electronVersion: '43.2.0',
    nodeVersion: '24.18.0',
    processType: 'utility',
    utpEnabled: false,
    webRtcSupported: true,
    webTorrentVersion: '3.0.16'
  } as const
  const engineSupervisor = {
    execute: vi.fn(async () => ({
      ok: true,
      result: {
        command: 'list-torrents',
        value: { items: [], nextCursor: null, total: 0 }
      }
    })),
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
      revision: options.stateRevision ?? 4,
      library: { torrents: [] },
      preferences: {
        downloadRoot: null,
        externalPlayer: null,
        torrentsFolder: null
      },
      window: { main: { normalBounds: null } }
    })
  } as unknown as AppStateStore
  const onBootstrap = vi.fn()
  const choosePath = vi.fn(async () => ({
    path: options.chosenPath ?? null,
    summary: options.chosenSummary ?? null
  }))
  const exportTorrent = vi.fn(
    options.exportTorrent ?? (async (_infoHash: string) => true)
  )
  const cleanup = registerDesktopIpc({
    captureSubtitleGrant: vi.fn(async () => subtitleGrant),
    choosePath,
    exportTorrent,
    ...(options.openTorrentMenu
      ? { openTorrentMenu: options.openTorrentMenu }
      : {}),
    diagnostics,
    engineSupervisor,
    getEngineStatusEvent: () => statusEvent,
    onBootstrap,
    runtime,
    stateStore,
    window: window as never
  })

  return {
    choosePath,
    cleanup,
    diagnostics,
    engineSupervisor,
    exportTorrent,
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

  it('does not trust the renderer when bootstrap result validation fails', async () => {
    const { event, handlers, onBootstrap } = createHarness({
      stateRevision: -1
    })
    const handler = handlers.get(DESKTOP_BOOTSTRAP_CHANNEL)

    expect(await handler?.(event, request('bootstrap'))).toMatchObject({
      ok: false,
      requestId,
      error: { code: 'INTERNAL', retryable: true }
    })
    expect(onBootstrap).not.toHaveBeenCalled()
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

  it('forwards a validated torrent command and returns its engine result', async () => {
    const { engineSupervisor, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_TORRENT_COMMAND_CHANNEL)

    const accepted = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      command: 'torrentCommand',
      payload: {
        operation: {
          command: 'list-torrents',
          payload: { cursor: 0, limit: 50 }
        }
      }
    })

    expect(accepted).toMatchObject({
      ok: true,
      value: { ok: true, result: { command: 'list-torrents' } }
    })
    expect(engineSupervisor.execute).toHaveBeenCalledWith({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 50 }
    })
  })

  it('refuses a torrent command that is not in the engine contract', async () => {
    const { engineSupervisor, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_TORRENT_COMMAND_CHANNEL)

    const rejected = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      command: 'torrentCommand',
      payload: { operation: { command: 'delete-everything', payload: {} } }
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', retryable: false }
    })
    expect(engineSupervisor.execute).not.toHaveBeenCalled()
  })

  it('keeps export paths behind the dedicated main-owned capability', async () => {
    const { engineSupervisor, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_TORRENT_COMMAND_CHANNEL)

    const rejected = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
      command: 'torrentCommand',
      payload: {
        operation: {
          command: 'export-torrent',
          payload: {
            destinationPath: '/Users/owner/Desktop/example.torrent',
            infoHash: '0'.repeat(40)
          }
        }
      }
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', retryable: false }
    })
    expect(engineSupervisor.execute).not.toHaveBeenCalled()
  })

  it('asks main to save an existing torrent without returning the path', async () => {
    const { event, exportTorrent, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_EXPORT_TORRENT_CHANNEL)
    const infoHash = '0'.repeat(40)

    const saved = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'ffffffff-ffff-4fff-8fff-fffffffffffd',
      command: 'exportTorrent',
      payload: { infoHash }
    })

    expect(saved).toMatchObject({
      ok: true,
      value: { saved: true }
    })
    expect(exportTorrent).toHaveBeenCalledWith(infoHash)
    expect(JSON.stringify(saved)).not.toContain('/Users/')
  })

  it('returns only the path the user chose', async () => {
    const { choosePath, event, handlers } = createHarness({
      chosenPath: '/Users/owner/Movies'
    })
    const handler = handlers.get(DESKTOP_CHOOSE_PATH_CHANNEL)

    const chosen = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '11111111-1111-4111-8111-111111111111',
      command: 'choosePath',
      payload: { kind: 'directory' }
    })

    expect(chosen).toMatchObject({
      ok: true,
      value: { path: '/Users/owner/Movies', summary: null }
    })
    expect(choosePath).toHaveBeenCalledWith('directory')
  })

  it('consumes a subtitle chooser path exactly once', async () => {
    const { engineSupervisor, event, handlers } = createHarness({
      chosenPath: '/Users/owner/captions.vtt'
    })
    const chooseHandler = handlers.get(DESKTOP_CHOOSE_PATH_CHANNEL)
    const torrentHandler = handlers.get(DESKTOP_TORRENT_COMMAND_CHANNEL)

    await chooseHandler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '11111111-1111-4111-8111-111111111113',
      command: 'choosePath',
      payload: { kind: 'subtitle' }
    })
    const operation = {
      command: 'open-external-subtitle',
      payload: {
        infoHash: '0'.repeat(40),
        mediaFileIndex: 1,
        path: '/Users/owner/captions.vtt'
      }
    } as const
    const first = await torrentHandler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '11111111-1111-4111-8111-111111111114',
      command: 'torrentCommand',
      payload: { operation }
    })
    const replay = await torrentHandler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '11111111-1111-4111-8111-111111111115',
      command: 'torrentCommand',
      payload: { operation }
    })

    expect(first).toMatchObject({ ok: true })
    expect(engineSupervisor.execute).toHaveBeenCalledOnce()
    expect(engineSupervisor.execute).toHaveBeenCalledWith({
      ...operation,
      payload: { ...operation.payload, grant: subtitleGrant }
    })
    expect(replay).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST', retryable: false }
    })
  })

  it('passes through the source measurement main took', async () => {
    const { event, handlers } = createHarness({
      chosenPath: '/Users/owner/Movies',
      chosenSummary: { fileCount: 4, totalBytes: 9_000 }
    })
    const handler = handlers.get(DESKTOP_CHOOSE_PATH_CHANNEL)

    const chosen = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '11111111-1111-4111-8111-111111111112',
      command: 'choosePath',
      payload: { kind: 'source' }
    })

    expect(chosen).toMatchObject({
      ok: true,
      value: {
        path: '/Users/owner/Movies',
        summary: { fileCount: 4, totalBytes: 9_000 }
      }
    })
  })

  it('asks main for the context menu and returns only whether it showed', async () => {
    const openTorrentMenu = vi.fn(() => true)
    const { event, handlers } = createHarness({ openTorrentMenu })
    const handler = handlers.get(DESKTOP_CONTEXT_MENU_CHANNEL)

    const shown = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '33333333-3333-4333-8333-333333333331',
      command: 'openContextMenu',
      payload: { infoHash: '0'.repeat(40) }
    })

    expect(shown).toMatchObject({ ok: true, value: { shown: true } })
    expect(openTorrentMenu).toHaveBeenCalledWith('0'.repeat(40))
  })

  it('refuses a context-menu request that names no real info hash', async () => {
    const openTorrentMenu = vi.fn(() => true)
    const { event, handlers } = createHarness({ openTorrentMenu })
    const handler = handlers.get(DESKTOP_CONTEXT_MENU_CHANNEL)

    const rejected = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '33333333-3333-4333-8333-333333333332',
      command: 'openContextMenu',
      payload: { infoHash: '../etc/passwd' }
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
    expect(openTorrentMenu).not.toHaveBeenCalled()
  })

  it('refuses a chooser request with an unknown kind', async () => {
    const { choosePath, event, handlers } = createHarness()
    const handler = handlers.get(DESKTOP_CHOOSE_PATH_CHANNEL)

    const rejected = await handler?.(event, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: '22222222-2222-4222-8222-222222222222',
      command: 'choosePath',
      payload: { kind: 'everything' }
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
    expect(choosePath).not.toHaveBeenCalled()
  })

  it('removes both private frame handlers during cleanup', () => {
    const { cleanup, handlers } = createHarness()

    cleanup()

    expect(handlers.size).toBe(0)
  })
})
