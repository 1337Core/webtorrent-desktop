/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreferencesPage } from './preferences'

const CHOSEN = '/Users/owner/Movies'

let chosenPath: string | null = CHOSEN
let saveFails = false
let setPreferences: ReturnType<typeof vi.fn>

beforeEach(() => {
  chosenPath = CHOSEN
  saveFails = false
  setPreferences = vi.fn((update: { downloadRoot?: string }) =>
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
            value: {
              preferences: {
                downloadRoot: update.downloadRoot ?? null,
                externalPlayer: null,
                torrentsFolder: null
              }
            }
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
          value: { path: chosenPath, summary: null }
        })
      ),
      getBootstrap: vi.fn(),
      onEngineStatus: vi.fn(() => () => undefined),
      restartEngine: vi.fn(),
      runTorrentCommand: vi.fn(),
      setPreferences
    },
    writable: true
  })
})

afterEach(() => {
  cleanup()
})

describe('PreferencesPage', () => {
  it('saves a folder chosen in the main-owned dialog', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <PreferencesPage
        onChanged={onChanged}
        preferences={{
          downloadRoot: null,
          externalPlayer: null,
          torrentsFolder: null
        }}
      />
    )

    expect(screen.getByLabelText('Download location:')).toHaveProperty(
      'value',
      ''
    )
    await user.click(
      screen.getByRole('button', { name: 'Change Download location' })
    )

    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(
        expect.objectContaining({ downloadRoot: CHOSEN })
      )
    )
    expect(setPreferences).toHaveBeenCalledWith({ downloadRoot: CHOSEN })
  })

  it('changes nothing when the chooser is cancelled', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    chosenPath = null
    render(
      <PreferencesPage
        onChanged={onChanged}
        preferences={{
          downloadRoot: '/Users/owner/Downloads',
          externalPlayer: null,
          torrentsFolder: null
        }}
      />
    )

    await user.click(
      screen.getByRole('button', { name: 'Change Download location' })
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Change Download location' })
      ).toHaveProperty('disabled', false)
    )
    expect(setPreferences).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a rejected folder', async () => {
    const user = userEvent.setup()
    saveFails = true
    render(
      <PreferencesPage
        onChanged={vi.fn()}
        preferences={{
          downloadRoot: null,
          externalPlayer: null,
          torrentsFolder: null
        }}
      />
    )

    await user.click(
      screen.getByRole('button', { name: 'Change Download location' })
    )

    expect(
      await screen.findByText('That download folder cannot be used.')
    ).toBeDefined()
  })
})
