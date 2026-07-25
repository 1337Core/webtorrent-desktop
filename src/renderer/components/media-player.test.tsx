/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { MediaPlayer } from './media-player'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const LEASE_ID = '00000000-0000-4000-8000-000000000020'
const MEDIA_URL = `http://127.0.0.1:52000/v1/media/${'a'.repeat(43)}`

let commands: EngineCommand[] = []
let failOpen = false

function response(operation: EngineCommand): TorrentCommandResult {
  const envelope = {
    protocolVersion: 1 as const,
    requestId: '00000000-0000-4000-8000-000000000001'
  }
  if (operation.command === 'open-media' && failOpen) {
    return {
      ...envelope,
      ok: true,
      value: {
        ok: false,
        error: {
          command: 'open-media',
          code: 'NOT_FOUND',
          displayMessage: 'That media stream is no longer available.',
          retryable: false
        }
      }
    } as TorrentCommandResult
  }

  switch (operation.command) {
    case 'open-media':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'open-media',
            value: {
              expiresAtMs: 60_000,
              fileIndex: 1,
              infoHash: INFO_HASH,
              leaseId: LEASE_ID,
              url: MEDIA_URL
            }
          }
        }
      } as TorrentCommandResult
    case 'heartbeat-media':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'heartbeat-media',
            value: { expiresAtMs: 120_000, leaseId: LEASE_ID }
          }
        }
      } as TorrentCommandResult
    default:
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'close-media',
            value: { closed: true, leaseId: LEASE_ID }
          }
        }
      } as TorrentCommandResult
  }
}

beforeEach(() => {
  commands = []
  failOpen = false
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      getBootstrap: vi.fn(),
      openExternalPlayer: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000004',
          ok: true,
          value: { launched: true }
        })
      ),
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

describe('MediaPlayer', () => {
  it('opens an opaque per-file stream and plays it', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )

    const element = await screen.findByTestId('media-element')
    expect(element.getAttribute('src')).toBe(MEDIA_URL)
    expect(commands[0]).toEqual({
      command: 'open-media',
      payload: { fileIndex: 1, infoHash: INFO_HASH }
    })
    // No path, torrent index, or server URL crosses the boundary.
    expect(MEDIA_URL).not.toContain('payload')
  })

  it('closes its lease when the player unmounts', async () => {
    const { unmount } = render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    unmount()
    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'close-media' &&
            command.payload.leaseId === LEASE_ID
        )
      ).toBe(true)
    )
  })

  it('reports a refused stream instead of rendering an element', async () => {
    failOpen = true
    render(
      <MediaPlayer
        fileIndex={9}
        fileName="payload/absent.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )

    expect(
      await screen.findByText('That media stream is no longer available.')
    ).toBeDefined()
    expect(screen.queryByTestId('media-element')).toBeNull()
  })

  it('hands control back when the player is closed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={onClose}
      />
    )
    await screen.findByTestId('media-element')

    await user.click(screen.getByRole('button', { name: 'Close player' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hands the minted URL to the configured external player', async () => {
    const user = userEvent.setup()
    render(
      <MediaPlayer
        externalPlayerConfigured
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    await user.click(
      screen.getByRole('button', { name: 'Open in external player' })
    )
    expect(window.desktop.openExternalPlayer).toHaveBeenCalledWith(MEDIA_URL)
  })

  it('offers no external player until one is configured', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    expect(
      screen.queryByRole('button', { name: 'Open in external player' })
    ).toBeNull()
  })
})
