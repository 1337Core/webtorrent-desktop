/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCommand, TorrentCommandResult } from '../shared/contracts'
import { App } from './app'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const MAGNET = `magnet:?xt=urn:btih:${INFO_HASH}`
const TORRENT_PATH = '/Users/owner/Downloads/example.torrent'

let commands: EngineCommand[] = []
let droppedPaths: string[] = []
let menuListener: ((action: string) => void) | null = null

function response(operation: EngineCommand): TorrentCommandResult {
  const envelope = {
    protocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001'
  }
  if (operation.command === 'open-preparation') {
    return {
      ...envelope,
      ok: true,
      value: {
        ok: true,
        result: {
          command: 'open-preparation',
          value: {
            expiresAtMs: 1_000,
            fileCount: 1,
            infoHash: INFO_HASH,
            length: 10,
            name: 'Prepared payload',
            preparationId: '00000000-0000-4000-8000-000000000010',
            private: false,
            selectedFileCount: 0,
            warnings: []
          }
        }
      }
    } as TorrentCommandResult
  }
  return {
    ...envelope,
    ok: true,
    value: {
      ok: true,
      result: {
        command: 'list-torrents',
        value: { items: [], nextCursor: null, total: 0 }
      }
    }
  } as TorrentCommandResult
}

function dataTransfer(
  files: ReadonlyArray<{ name: string }>,
  text = ''
): DataTransfer {
  return {
    files,
    getData: () => text,
    items: [],
    types: []
  } as unknown as DataTransfer
}

beforeEach(() => {
  commands = []
  droppedPaths = [TORRENT_PATH]
  menuListener = null
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      choosePath: vi.fn(),
      getBootstrap: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000002',
          ok: true,
          value: {
            protocolVersion: 1,
            engineStatusEvent: {
              protocolVersion: 1,
              eventId: '00000000-0000-4000-8000-000000000003',
              sequence: 1,
              status: {
                state: 'ready',
                generationId: '00000000-0000-4000-8000-000000000004',
                restartCount: 0,
                architecture: 'arm64',
                mediaPort: 52_000,
                electronVersion: '43.2.0',
                nodeVersion: '24.18.0',
                processType: 'utility',
                utpEnabled: false,
                webRtcSupported: true,
                webTorrentVersion: '3.0.16'
              }
            },
            state: {
              schemaVersion: 1,
              revision: 1,
              preferences: {
                downloadRoot: '/Users/owner/Downloads',
                externalPlayer: null,
                torrentsFolder: null
              }
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
        })
      ),
      onEngineStatus: vi.fn(() => () => undefined),
      onMenuAction: vi.fn((listener: (action: string) => void) => {
        menuListener = listener
        return () => undefined
      }),
      onOpenIntent: vi.fn(() => () => undefined),
      openExternalPlayer: vi.fn(),
      openTorrentMenu: vi.fn(),
      resolveDroppedTorrents: vi.fn(() => droppedPaths),
      restartEngine: vi.fn(),
      runTorrentCommand: vi.fn((operation: EngineCommand) => {
        commands.push(operation)
        return Promise.resolve(response(operation))
      }),
      setPreferences: vi.fn()
    },
    writable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('prepares a torrent file dropped on the window', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Drop a torrent file here or paste a magnet link')

    const root = document.querySelector('.app')
    if (!root) throw new Error('The application shell did not render')
    await user.pointer({ keys: '[MouseLeft]', target: root })
    root.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: dataTransfer([{ name: 'example.torrent' }])
      })
    )

    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'open-preparation' &&
            command.payload.source.kind === 'local-torrent'
        )
      ).toBe(true)
    )
    expect(await screen.findByText('Prepared payload')).toBeDefined()
  })

  it('prepares a magnet link pasted into the window', async () => {
    render(<App />)
    await screen.findByText('Drop a torrent file here or paste a magnet link')

    document.dispatchEvent(
      Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
        clipboardData: { getData: () => MAGNET }
      })
    )

    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'open-preparation' &&
            command.payload.source.kind === 'magnet'
        )
      ).toBe(true)
    )
  })

  it('ignores a drop that carries nothing the app can add', async () => {
    droppedPaths = []
    render(<App />)
    await screen.findByText('Drop a torrent file here or paste a magnet link')

    const root = document.querySelector('.app')
    if (!root) throw new Error('The application shell did not render')
    root.dispatchEvent(
      Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
        dataTransfer: dataTransfer([{ name: 'movie.mp4' }], 'not a magnet')
      })
    )

    await waitFor(() => expect(commands.length).toBeGreaterThan(0))
    expect(
      commands.every(command => command.command !== 'open-preparation')
    ).toBe(true)
  })

  it('walks the header history with both chevrons', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('Drop a torrent file here or paste a magnet link')

    expect(screen.getByRole('button', { name: 'Back' }).className).toContain(
      'disabled'
    )

    menuListener?.('preferences')
    expect(await screen.findByText('Folders')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      await screen.findByText('Drop a torrent file here or paste a magnet link')
    ).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Forward' }))
    expect(await screen.findByText('Folders')).toBeDefined()
  })
})
