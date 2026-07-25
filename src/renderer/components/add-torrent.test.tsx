/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { AddTorrent } from './add-torrent'

const PREPARATION_ID = '00000000-0000-4000-8000-000000000010'
const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const DOWNLOAD_ROOT = '/Users/owner/Downloads'

let commands: EngineCommand[] = []
let failNext: string | null = null

function envelope(): { protocolVersion: 1; requestId: string } {
  return {
    protocolVersion: 1,
    requestId: '00000000-0000-4000-8000-000000000001'
  }
}

function response(operation: EngineCommand): TorrentCommandResult {
  if (failNext) {
    const displayMessage = failNext
    failNext = null
    return {
      ...envelope(),
      ok: true,
      value: {
        ok: false,
        error: {
          command: operation.command,
          code: 'NOT_FOUND',
          displayMessage,
          retryable: false
        }
      }
    } as TorrentCommandResult
  }

  switch (operation.command) {
    case 'open-preparation':
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'open-preparation',
            value: {
              expiresAtMs: 1_000,
              fileCount: 2,
              infoHash: INFO_HASH,
              length: 40,
              name: 'Prepared payload',
              preparationId: PREPARATION_ID,
              private: false,
              selectedFileCount: 0,
              warnings: ['WEB_SEED_DISABLED']
            }
          }
        }
      } as TorrentCommandResult
    case 'discard-preparation':
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'discard-preparation',
            value: { discarded: true, preparationId: PREPARATION_ID }
          }
        }
      } as TorrentCommandResult
    default:
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'commit-preparation',
            value: {
              preparationId: PREPARATION_ID,
              torrent: {
                downloadSpeed: 0,
                downloaded: 0,
                fileCount: 2,
                infoHash: INFO_HASH,
                length: 40,
                name: 'Prepared payload',
                peerCount: 0,
                private: false,
                progress: 0,
                selectedFileCount: 2,
                state: 'paused',
                timeRemainingMs: null,
                uploadSpeed: 0,
                uploaded: 0
              }
            }
          }
        }
      } as TorrentCommandResult
  }
}

beforeEach(() => {
  commands = []
  failNext = null
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

describe('AddTorrent', () => {
  it('prepares a remote torrent for review before writing anything', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    render(<AddTorrent downloadRoot={DOWNLOAD_ROOT} onAdded={onAdded} ready />)

    await user.type(
      screen.getByLabelText('Torrent file URL'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'Prepare' }))

    expect(await screen.findByText('Prepared payload')).toBeDefined()
    expect(commands[0]).toEqual({
      command: 'open-preparation',
      payload: {
        source: {
          allowHttp: false,
          allowPrivateNetwork: false,
          kind: 'remote-torrent',
          url: 'https://example.com/file.torrent'
        }
      }
    })
    expect(
      screen.getByText('Web seeds are disabled in this release.')
    ).toBeDefined()
    expect(screen.getByText(`Saving to ${DOWNLOAD_ROOT}`)).toBeDefined()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('commits the reviewed preparation into the chosen root', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    render(<AddTorrent downloadRoot={DOWNLOAD_ROOT} onAdded={onAdded} ready />)

    await user.type(
      screen.getByLabelText('Torrent file URL'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'Prepare' }))
    await screen.findByText('Prepared payload')
    await user.click(screen.getByRole('button', { name: 'Start download' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce())
    expect(commands.at(-1)).toEqual({
      command: 'commit-preparation',
      payload: {
        destinationRoot: DOWNLOAD_ROOT,
        preparationId: PREPARATION_ID
      }
    })
    expect(screen.getByLabelText('Torrent file URL')).toHaveProperty(
      'value',
      ''
    )
  })

  it('discards a preparation instead of leaving it open', async () => {
    const user = userEvent.setup()
    render(<AddTorrent downloadRoot={DOWNLOAD_ROOT} onAdded={vi.fn()} ready />)

    await user.type(
      screen.getByLabelText('Torrent file URL'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'Prepare' }))
    await screen.findByText('Prepared payload')
    await user.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() =>
      expect(screen.getByLabelText('Torrent file URL')).toBeDefined()
    )
    expect(commands.at(-1)).toEqual({
      command: 'discard-preparation',
      payload: { preparationId: PREPARATION_ID }
    })
  })

  it('refuses to commit without a download root', async () => {
    const user = userEvent.setup()
    render(<AddTorrent downloadRoot={null} onAdded={vi.fn()} ready />)

    await user.type(
      screen.getByLabelText('Torrent file URL'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'Prepare' }))
    await screen.findByText('Prepared payload')

    expect(
      screen.getByText('No download folder is available yet.')
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Start download' })
    ).toHaveProperty('disabled', true)
  })

  it('waits for a ready engine and a URL before preparing', () => {
    render(<AddTorrent downloadRoot={DOWNLOAD_ROOT} onAdded={vi.fn()} ready />)

    expect(screen.getByRole('button', { name: 'Prepare' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it('surfaces a rejected preparation', async () => {
    const user = userEvent.setup()
    render(<AddTorrent downloadRoot={DOWNLOAD_ROOT} onAdded={vi.fn()} ready />)

    failNext = 'The remote torrent could not be loaded.'
    await user.type(
      screen.getByLabelText('Torrent file URL'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'Prepare' }))

    expect(
      await screen.findByText('The remote torrent could not be loaded.')
    ).toBeDefined()
  })
})
