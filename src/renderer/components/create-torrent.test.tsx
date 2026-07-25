/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { CreateTorrent } from './create-torrent'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const SOURCE = '/Users/owner/Movies/clip.mp4'

let commands: EngineCommand[] = []
let chosenPath: string | null = SOURCE
let failNext: string | null = null

function response(operation: EngineCommand): TorrentCommandResult {
  const envelope = {
    protocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001'
  }
  if (failNext) {
    const displayMessage = failNext
    failNext = null
    return {
      ...envelope,
      ok: true,
      value: {
        ok: false,
        error: {
          command: operation.command,
          code: 'INPUT_INVALID',
          displayMessage,
          retryable: false
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
        command: 'create-torrent',
        value: {
          operationId: '00000000-0000-4000-8000-000000000030',
          torrent: {
            downloadSpeed: 0,
            downloaded: 0,
            fileCount: 1,
            infoHash: INFO_HASH,
            length: 40,
            name: 'clip.mp4',
            peerCount: 0,
            private: false,
            progress: 1,
            selectedFileCount: 1,
            state: 'seeding',
            timeRemainingMs: null,
            uploadSpeed: 0,
            uploaded: 0
          }
        }
      }
    }
  } as TorrentCommandResult
}

beforeEach(() => {
  commands = []
  chosenPath = SOURCE
  failNext = null
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      choosePath: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000002',
          ok: true,
          value: { path: chosenPath }
        })
      ),
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

describe('CreateTorrent', () => {
  it('creates from a chosen source and seeds in place', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    render(<CreateTorrent onCreated={onCreated} ready />)

    expect(
      screen.getByRole('button', { name: 'Create and seed' })
    ).toHaveProperty('disabled', true)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    expect(await screen.findByText(SOURCE)).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Create and seed' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())

    const created = commands.at(-1)
    expect(created).toMatchObject({
      command: 'create-torrent',
      payload: {
        allowHttpTrackers: false,
        allowPrivateNetwork: false,
        announceTiers: [],
        destinationRoot: SOURCE,
        filterJunkFiles: true,
        private: false,
        sourcePath: SOURCE
      }
    })
    expect(await screen.findByText('Seeding clip.mp4.')).toBeDefined()
  })

  it('sends a typed tracker as one tier', async () => {
    const user = userEvent.setup()
    render(<CreateTorrent onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.type(
      screen.getByLabelText('Tracker (optional)'),
      'https://tracker.example/announce'
    )
    await user.click(screen.getByRole('button', { name: 'Create and seed' }))

    await waitFor(() =>
      expect(commands.at(-1)).toMatchObject({
        payload: {
          announceTiers: [['https://tracker.example/announce']]
        }
      })
    )
  })

  it('requires a tracker before a private torrent can be created', async () => {
    const user = userEvent.setup()
    render(<CreateTorrent onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(screen.getByLabelText(/Private torrent/u))

    expect(
      screen.getByRole('button', { name: 'Create and seed' })
    ).toHaveProperty('disabled', true)
  })

  it('keeps its state when the chooser is cancelled', async () => {
    const user = userEvent.setup()
    chosenPath = null
    render(<CreateTorrent onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )

    expect(screen.getByText('Nothing selected yet.')).toBeDefined()
    expect(commands).toEqual([])
  })

  it('surfaces a rejected creation', async () => {
    const user = userEvent.setup()
    render(<CreateTorrent onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    failNext = 'A selected tracker is not supported.'
    await user.click(screen.getByRole('button', { name: 'Create and seed' }))

    expect(
      await screen.findByText('A selected tracker is not supported.')
    ).toBeDefined()
  })
})
