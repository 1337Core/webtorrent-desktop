/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EngineCommand,
  TorrentCommandResult
} from '../../shared/contracts'
import { CreateTorrentPage } from './create-torrent'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const SOURCE = '/Users/owner/Movies/clip.mp4'

let commands: EngineCommand[] = []
let chosenPath: string | null = SOURCE
let chosenSummary: { fileCount: number; totalBytes: number } | null = {
  fileCount: 3,
  totalBytes: 2_500
}
let failNext: string | null = null
let exportFailure: string | null = null
let exportSaved = true
let exportedHashes: string[] = []

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
  chosenSummary = { fileCount: 3, totalBytes: 2_500 }
  failNext = null
  exportFailure = null
  exportSaved = true
  exportedHashes = []
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      choosePath: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000002',
          ok: true,
          value: { path: chosenPath, summary: chosenSummary }
        })
      ),
      exportTorrent: vi.fn((infoHash: string) => {
        exportedHashes.push(infoHash)
        if (exportFailure) {
          const displayMessage = exportFailure
          exportFailure = null
          return Promise.resolve({
            protocolVersion: 1 as const,
            requestId: '00000000-0000-4000-8000-000000000003',
            ok: false as const,
            error: {
              code: 'INTERNAL' as const,
              displayMessage,
              retryable: true
            }
          })
        }
        return Promise.resolve({
          protocolVersion: 1 as const,
          requestId: '00000000-0000-4000-8000-000000000003',
          ok: true as const,
          value: { saved: exportSaved }
        })
      }),
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

describe('CreateTorrentPage', () => {
  it('creates from a chosen source and seeds in place', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={onCreated} ready />)

    expect(
      screen.getByRole('button', { name: 'Create Torrent' })
    ).toHaveProperty('disabled', true)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    expect(await screen.findByText(SOURCE)).toBeDefined()
    // The original showed the file count and total size under the heading.
    expect(screen.getByText('3 files, 2.5 kB')).toBeDefined()
    expect(screen.getByText('Create torrent clip.mp4')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(exportedHashes).toEqual([INFO_HASH])

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

  it('sends each advanced tracker line as one tier', async () => {
    const user = userEvent.setup()
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(
      screen.getByRole('button', { name: 'Show advanced settings...' })
    )
    await user.type(
      screen.getByLabelText('Trackers:'),
      'https://tracker.example/announce'
    )
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))

    await waitFor(() =>
      expect(commands.at(-1)).toMatchObject({
        payload: {
          announceTiers: [['https://tracker.example/announce']]
        }
      })
    )
  })

  it('sends the advanced comment when one is typed', async () => {
    const user = userEvent.setup()
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(
      screen.getByRole('button', { name: 'Show advanced settings...' })
    )
    await user.type(screen.getByLabelText('Comment:'), 'Home video')
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))

    await waitFor(() =>
      expect(commands.at(-1)).toMatchObject({
        payload: { comment: 'Home video' }
      })
    )
  })

  it('requires a tracker before a private torrent can be created', async () => {
    const user = userEvent.setup()
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(
      screen.getByRole('button', { name: 'Show advanced settings...' })
    )
    await user.click(screen.getByLabelText('Private:'))

    expect(
      screen.getByRole('button', { name: 'Create Torrent' })
    ).toHaveProperty('disabled', true)
  })

  it('keeps its state when the chooser is cancelled', async () => {
    const user = userEvent.setup()
    chosenPath = null
    chosenSummary = null
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )

    expect(screen.getByText('Create torrent')).toBeDefined()
    expect(commands).toEqual([])
  })

  it('leaves the screen when the original Cancel button is used', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<CreateTorrentPage onCancel={onCancel} onCreated={vi.fn()} ready />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(commands).toEqual([])
  })

  it('shows the path alone when main could not measure the source', async () => {
    const user = userEvent.setup()
    chosenSummary = null
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )

    await waitFor(() => expect(screen.getAllByText(SOURCE)).toHaveLength(2))
  })

  it('surfaces a rejected creation', async () => {
    const user = userEvent.setup()
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={vi.fn()} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    failNext = 'A selected tracker is not supported.'
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))

    expect(
      await screen.findByText('A selected tracker is not supported.')
    ).toBeDefined()
    expect(exportedHashes).toEqual([])
  })

  it('lets a completed creation retry a failed export', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    exportFailure = 'The torrent file could not be saved.'
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={onCreated} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))

    expect(
      await screen.findByText('The torrent file could not be saved.')
    ).toBeDefined()
    expect(screen.getByText('Seeding clip.mp4.')).toBeDefined()
    expect(onCreated).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Save Torrent File...' })
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(exportedHashes).toEqual([INFO_HASH, INFO_HASH])
  })

  it('keeps a completed creation open when the initial save is cancelled', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    exportSaved = false
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={onCreated} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))

    await waitFor(() => expect(exportedHashes).toEqual([INFO_HASH]))
    expect(screen.getByText('Seeding clip.mp4.')).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Save Torrent File...' })
    ).toBeDefined()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('keeps the retry available when its save dialog is cancelled', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    exportFailure = 'The torrent file could not be saved.'
    render(<CreateTorrentPage onCancel={vi.fn()} onCreated={onCreated} ready />)

    await user.click(
      screen.getByRole('button', { name: 'Choose file or folder' })
    )
    await screen.findByText(SOURCE)
    await user.click(screen.getByRole('button', { name: 'Create Torrent' }))
    await screen.findByText('The torrent file could not be saved.')

    exportSaved = false
    await user.click(
      screen.getByRole('button', { name: 'Save Torrent File...' })
    )

    await waitFor(() => expect(exportedHashes).toEqual([INFO_HASH, INFO_HASH]))
    expect(
      screen.getByRole('button', { name: 'Save Torrent File...' })
    ).toBeDefined()
    expect(onCreated).not.toHaveBeenCalled()
  })
})
