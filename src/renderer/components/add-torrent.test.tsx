/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { AddTorrentModal } from './add-torrent'

const PREPARATION_ID = '00000000-0000-4000-8000-000000000010'
const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const DOWNLOAD_ROOT = '/Users/owner/Downloads'
const ACQUISITION_ID = '00000000-0000-4000-8000-000000000020'

let commands: EngineCommand[] = []
let failNext: string | null = null
let requireDhtConsent = false

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
    case 'start-acquisition':
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'start-acquisition',
            value: { acquisitionId: ACQUISITION_ID }
          }
        }
      } as TorrentCommandResult
    case 'get-acquisition':
      if (
        requireDhtConsent &&
        !commands.some(
          command =>
            command.command === 'start-acquisition' &&
            command.payload.source.allowDhtExposure
        )
      ) {
        return {
          ...envelope(),
          ok: true,
          value: {
            ok: true,
            result: {
              command: 'get-acquisition',
              value: {
                code: 'DHT_CONSENT_REQUIRED',
                state: 'failed'
              }
            }
          }
        } as TorrentCommandResult
      }
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'get-acquisition',
            value: {
              preparation: {
                expiresAtMs: 1_000,
                fileCount: 2,
                infoHash: INFO_HASH,
                length: 40,
                name: 'Prepared payload',
                preparationId: PREPARATION_ID,
                private: false,
                selectedFileCount: 0,
                warnings: ['WEB_SEED_DISABLED']
              },
              state: 'ready'
            }
          }
        }
      } as TorrentCommandResult
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
    case 'get-preparation-files':
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'get-preparation-files',
            value: {
              items: [
                {
                  downloaded: 0,
                  index: 0,
                  length: 20,
                  path: 'payload/first.bin',
                  progress: 0,
                  selected: true
                },
                {
                  downloaded: 0,
                  index: 1,
                  length: 20,
                  path: 'payload/second.bin',
                  progress: 0,
                  selected: false
                }
              ],
              nextCursor: null,
              preparationId: PREPARATION_ID,
              total: 2
            }
          }
        }
      } as TorrentCommandResult
    case 'update-preparation-selection':
      return {
        ...envelope(),
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'update-preparation-selection',
            value: { preparationId: PREPARATION_ID, selectedFileCount: 2 }
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
  requireDhtConsent = false
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanup()
})

describe('AddTorrentModal', () => {
  it('prepares a remote torrent for review before writing anything', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={onAdded}
        ready
      />
    )

    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))

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

  it('lists the manifest and toggles a file through the engine', async () => {
    const user = userEvent.setup()
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))

    const first = await screen.findByLabelText(/payload\/first\.bin/u)
    const second = screen.getByLabelText(/payload\/second\.bin/u)
    expect(first).toHaveProperty('checked', true)
    expect(second).toHaveProperty('checked', false)

    await user.click(second)
    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'update-preparation-selection' &&
            command.payload.changes[0]?.index === 1 &&
            command.payload.changes[0].selected === true
        )
      ).toBe(true)
    )
    await waitFor(() => expect(second).toHaveProperty('checked', true))
  })

  it('commits the reviewed preparation into the chosen root', async () => {
    const user = userEvent.setup()
    const onAdded = vi.fn()
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={onAdded}
        ready
      />
    )

    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Prepared payload')
    await user.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(onAdded).toHaveBeenCalledOnce())
    expect(commands.at(-1)).toEqual({
      command: 'commit-preparation',
      payload: {
        destinationRoot: DOWNLOAD_ROOT,
        preparationId: PREPARATION_ID
      }
    })
    expect(
      screen.getByLabelText('Enter torrent address or magnet link')
    ).toHaveProperty('value', '')
  })

  it('discards a preparation instead of leaving it open', async () => {
    const user = userEvent.setup()
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Prepared payload')
    await user.click(screen.getByRole('button', { name: 'CANCEL' }))

    await waitFor(() =>
      expect(
        screen.getByLabelText('Enter torrent address or magnet link')
      ).toBeDefined()
    )
    expect(commands.at(-1)).toEqual({
      command: 'discard-preparation',
      payload: { preparationId: PREPARATION_ID }
    })
  })

  it('refuses to commit without a download root', async () => {
    const user = userEvent.setup()
    render(
      <AddTorrentModal
        downloadRoot={null}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))
    await screen.findByText('Prepared payload')

    expect(
      screen.getByText('No download folder is available yet.')
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'OK' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it('waits for a ready engine and a URL before preparing', () => {
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    expect(screen.getByRole('button', { name: 'OK' })).toHaveProperty(
      'disabled',
      true
    )
  })

  it('surfaces a rejected preparation', async () => {
    const user = userEvent.setup()
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    failNext = 'The remote torrent could not be loaded.'
    await user.type(
      screen.getByLabelText('Enter torrent address or magnet link'),
      'https://example.com/file.torrent'
    )
    await user.click(screen.getByRole('button', { name: 'OK' }))

    expect(
      await screen.findByText('The remote torrent could not be loaded.')
    ).toBeDefined()
  })

  it('prepares a torrent opened from Finder', async () => {
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        intent={{ kind: 'torrent-file', torrentPath: '/Users/owner/a.torrent' }}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    expect(await screen.findByText('Prepared payload')).toBeDefined()
    expect(commands[0]).toEqual({
      command: 'open-preparation',
      payload: {
        source: { kind: 'local-torrent', path: '/Users/owner/a.torrent' }
      }
    })
  })

  it('prepares a magnet link opened from the OS', async () => {
    const magnet = `magnet:?xt=urn:btih:${INFO_HASH}`
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        intent={{ kind: 'magnet', magnet }}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    // A magnet has no manifest yet, so the dialog says so while the engine
    // acquires it rather than appearing to hang.
    expect((await screen.findByRole('status')).textContent).toContain(
      'Fetching torrent details'
    )
    expect(commands[0]).toEqual({
      command: 'start-acquisition',
      payload: {
        source: {
          allowDhtExposure: false,
          allowPrivateNetwork: false,
          kind: 'magnet',
          magnet
        }
      }
    })

    await waitFor(() =>
      expect(
        commands.some(command => command.command === 'get-acquisition')
      ).toBe(true)
    )
    expect(await screen.findByText('Prepared payload')).toBeTruthy()
  })

  it('asks before retrying a trackerless info hash through the DHT', async () => {
    vi.useFakeTimers()
    requireDhtConsent = true
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready
      />
    )

    fireEvent.change(
      screen.getByLabelText('Enter torrent address or magnet link'),
      { target: { value: INFO_HASH } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(screen.getByText('Prepared payload')).toBeTruthy()
    expect(confirm).toHaveBeenCalledOnce()
    const starts = commands.filter(
      command => command.command === 'start-acquisition'
    )
    expect(starts).toEqual([
      {
        command: 'start-acquisition',
        payload: {
          source: {
            allowDhtExposure: false,
            allowPrivateNetwork: false,
            infoHash: INFO_HASH,
            kind: 'info-hash'
          }
        }
      },
      {
        command: 'start-acquisition',
        payload: {
          source: {
            allowDhtExposure: true,
            allowPrivateNetwork: false,
            infoHash: INFO_HASH,
            kind: 'info-hash'
          }
        }
      }
    ])
  })

  it('ignores an intent while the engine is not ready', () => {
    render(
      <AddTorrentModal
        downloadRoot={DOWNLOAD_ROOT}
        intent={{ kind: 'torrent-file', torrentPath: '/Users/owner/a.torrent' }}
        onCancel={vi.fn()}
        onAdded={vi.fn()}
        ready={false}
      />
    )

    expect(commands).toEqual([])
  })
})
