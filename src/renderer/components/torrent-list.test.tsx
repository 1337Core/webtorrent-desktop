/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { TorrentList } from './torrent-list'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

type Summary = {
  downloadSpeed: number
  downloaded: number
  fileCount: number
  infoHash: string
  length: number
  name: string
  peerCount: number
  private: boolean
  progress: number
  selectedFileCount: number
  state: 'checking' | 'downloading' | 'error' | 'paused' | 'seeding' | 'stopped'
  timeRemainingMs: number | null
  uploadSpeed: number
  uploaded: number
}

let items: Summary[] = []
let commands: EngineCommand[] = []
let failNext: { code: string; displayMessage: string } | null = null
let onPlay = vi.fn()

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    downloadSpeed: 2_000,
    downloaded: 500,
    fileCount: 2,
    infoHash: INFO_HASH,
    length: 1_000,
    name: 'Example payload',
    peerCount: 3,
    private: false,
    progress: 0.5,
    selectedFileCount: 1,
    state: 'downloading',
    timeRemainingMs: null,
    uploadSpeed: 0,
    uploaded: 0,
    ...overrides
  }
}

function response(operation: EngineCommand): TorrentCommandResult {
  const envelope = {
    protocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001'
  }
  if (failNext) {
    const error = failNext
    failNext = null
    return {
      ...envelope,
      ok: true,
      value: {
        ok: false,
        error: {
          command: operation.command,
          code: error.code as never,
          displayMessage: error.displayMessage,
          retryable: false
        }
      }
    } as TorrentCommandResult
  }

  switch (operation.command) {
    case 'list-torrents':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'list-torrents',
            value: { items, nextCursor: null, total: items.length }
          }
        }
      } as TorrentCommandResult
    case 'get-torrent-files':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'get-torrent-files',
            value: {
              infoHash: INFO_HASH,
              items: [
                {
                  downloaded: 10,
                  index: 0,
                  length: 20,
                  path: 'payload/movie.mp4',
                  progress: 0.5,
                  selected: true
                }
              ],
              nextCursor: null,
              total: 1
            }
          }
        }
      } as TorrentCommandResult
    case 'pause-torrent':
    case 'resume-torrent':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: { command: operation.command, value: items[0] as Summary }
        }
      } as TorrentCommandResult
    default:
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'remove-torrent',
            value: { infoHash: INFO_HASH, removed: true }
          }
        }
      } as TorrentCommandResult
  }
}

beforeEach(() => {
  items = [summary()]
  commands = []
  failNext = null
  onPlay = vi.fn()
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      getBootstrap: vi.fn(),
      onEngineStatus: vi.fn(() => () => undefined),
      restartEngine: vi.fn(),
      runTorrentCommand: vi.fn((operation: EngineCommand) => {
        commands.push(operation)
        return Promise.resolve(response(operation))
      })
    },
    writable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('TorrentList', () => {
  it('renders the engine page with bounded display values', async () => {
    render(<TorrentList active onPlay={onPlay} refreshMs={100_000} />)

    expect(await screen.findByText('Example payload')).toBeDefined()
    const meta = document.querySelector('.torrent-meta')?.textContent
    expect(meta).toBe('Downloading · 50% · 1.0 kB · ↓ 2.0 kB/s · ↑ — · 3 peers')
    expect(commands[0]).toEqual({
      command: 'list-torrents',
      payload: { cursor: 0, limit: 64 }
    })
  })

  it('shows an empty state before any torrent exists', async () => {
    items = []
    render(<TorrentList active onPlay={onPlay} refreshMs={100_000} />)

    expect(await screen.findByText('No torrents yet.')).toBeDefined()
  })

  it('stays quiet while the engine is not ready', () => {
    render(<TorrentList active={false} onPlay={onPlay} />)

    expect(commands).toEqual([])
  })

  it('pauses, resumes, and removes through the engine', async () => {
    const user = userEvent.setup()
    render(<TorrentList active onPlay={onPlay} refreshMs={100_000} />)
    await screen.findByText('Example payload')

    // The refresh after the action re-reads the engine page, so the fake
    // engine reports the new state before the click.
    items = [summary({ state: 'paused' })]
    await user.click(screen.getByRole('button', { name: /^Pause/u }))
    await waitFor(() =>
      expect(
        commands.some(command => command.command === 'pause-torrent')
      ).toBe(true)
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Resume/u })).toBeDefined()
    )

    items = [summary({ state: 'downloading' })]
    await user.click(screen.getByRole('button', { name: /^Resume/u }))
    await waitFor(() =>
      expect(
        commands.some(command => command.command === 'resume-torrent')
      ).toBe(true)
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Pause/u })).toBeDefined()
    )
    items = []
    await user.click(screen.getByRole('button', { name: /^Remove/u }))
    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'remove-torrent' &&
            command.payload.deleteData === false
        )
      ).toBe(true)
    )
  })

  it('reports an engine failure without dropping the list', async () => {
    const user = userEvent.setup()
    render(<TorrentList active onPlay={onPlay} refreshMs={100_000} />)
    await screen.findByText('Example payload')

    failNext = {
      code: 'STATE_CONFLICT',
      displayMessage: 'The torrent cannot change state right now.'
    }
    await user.click(screen.getByRole('button', { name: /^Pause/u }))

    expect(
      await screen.findByText('The torrent cannot change state right now.')
    ).toBeDefined()
    expect(screen.getByText('Example payload')).toBeDefined()
  })

  it('browses torrent files and hands one to the player', async () => {
    const user = userEvent.setup()
    render(<TorrentList active onPlay={onPlay} refreshMs={100_000} />)
    await screen.findByText('Example payload')

    await user.click(screen.getByRole('button', { name: /^Files of/u }))
    const play = await screen.findByRole('button', {
      name: 'Play payload/movie.mp4'
    })
    await user.click(play)

    expect(onPlay).toHaveBeenCalledWith({
      fileIndex: 0,
      fileName: 'payload/movie.mp4',
      infoHash: INFO_HASH
    })
  })
})
