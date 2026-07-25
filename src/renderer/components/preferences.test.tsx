/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Preferences } from './preferences'

const CHOSEN = '/Users/owner/Movies'

let chosenPath: string | null = CHOSEN
let saveFails = false
let setDownloadRoot: ReturnType<typeof vi.fn>

beforeEach(() => {
  chosenPath = CHOSEN
  saveFails = false
  setDownloadRoot = vi.fn((downloadRoot: string) =>
    Promise.resolve(
      saveFails
        ? {
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000003',
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              displayMessage: 'That download folder cannot be used.',
              retryable: false
            }
          }
        : {
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000003',
            ok: true,
            value: { preferences: { downloadRoot } }
          }
    )
  )
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
      runTorrentCommand: vi.fn(),
      setDownloadRoot
    },
    writable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('Preferences', () => {
  it('saves a folder chosen in the main-owned dialog', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(<Preferences downloadRoot={null} onChanged={onChanged} />)

    expect(screen.getByText('No download folder yet.')).toBeDefined()
    await user.click(
      screen.getByRole('button', { name: 'Change download folder' })
    )

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(CHOSEN))
    expect(setDownloadRoot).toHaveBeenCalledWith(CHOSEN)
  })

  it('changes nothing when the chooser is cancelled', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    chosenPath = null
    render(
      <Preferences
        downloadRoot="/Users/owner/Downloads"
        onChanged={onChanged}
      />
    )

    await user.click(
      screen.getByRole('button', { name: 'Change download folder' })
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Change download folder' })
      ).toHaveProperty('disabled', false)
    )
    expect(setDownloadRoot).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a rejected folder', async () => {
    const user = userEvent.setup()
    saveFails = true
    render(<Preferences downloadRoot={null} onChanged={vi.fn()} />)

    await user.click(
      screen.getByRole('button', { name: 'Change download folder' })
    )

    expect(
      await screen.findByText('That download folder cannot be used.')
    ).toBeDefined()
  })
})
