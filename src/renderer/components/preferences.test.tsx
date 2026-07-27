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
  setPreferences = vi.fn(
    (update: { downloadRoot?: string; openAtLogin?: boolean }) =>
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
                  openAtLogin: update.openAtLogin ?? false,
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
          openAtLogin: false,
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
          openAtLogin: false,
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
          openAtLogin: false,
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

describe('startup and legacy import', () => {
  it('records opening at login as an explicit choice', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    render(
      <PreferencesPage
        onChanged={onChanged}
        preferences={{
          downloadRoot: null,
          externalPlayer: null,
          openAtLogin: false,
          torrentsFolder: null
        }}
      />
    )

    await user.click(
      screen.getByRole('checkbox', {
        name: /Open WebTorrent Updated at login/u
      })
    )

    await waitFor(() =>
      expect(setPreferences).toHaveBeenCalledWith({ openAtLogin: true })
    )
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ openAtLogin: true })
    )
  })

  it('reads a chosen legacy profile and imports what it can', async () => {
    const user = userEvent.setup()
    const commands: Array<{ command: string; payload: unknown }> = []
    const desktop = window.desktop as unknown as {
      runTorrentCommand: ReturnType<typeof vi.fn>
    }
    desktop.runTorrentCommand = vi.fn(
      (operation: { command: string; payload: unknown }) => {
        commands.push(operation)
        const envelope = {
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000004'
        }
        if (operation.command === 'list-legacy-imports') {
          return Promise.resolve({
            ...envelope,
            ok: true,
            value: {
              ok: true,
              result: {
                command: 'list-legacy-imports',
                value: {
                  items: [
                    {
                      fileCount: 2,
                      infoHash: 'a'.repeat(40),
                      kind: 'importable',
                      length: 40,
                      name: 'Kept torrent',
                      private: false,
                      selectedFileCount: 2
                    },
                    {
                      kind: 'skipped',
                      name: 'Broken torrent',
                      reason: 'INVALID'
                    }
                  ],
                  nextCursor: null,
                  skippedCount: 1,
                  total: 2
                }
              }
            }
          })
        }
        return Promise.resolve({
          ...envelope,
          ok: true,
          value: {
            ok: true,
            result: {
              command: 'import-legacy-torrent',
              value: {
                infoHash: 'a'.repeat(40),
                torrent: {
                  addedAtMs: 1,
                  downloadSpeed: 0,
                  downloaded: 0,
                  fileCount: 2,
                  infoHash: 'a'.repeat(40),
                  length: 40,
                  name: 'Kept torrent',
                  numPeers: 0,
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
        })
      }
    )

    const onImported = vi.fn()
    render(
      <PreferencesPage
        onChanged={vi.fn()}
        onImported={onImported}
        preferences={{
          downloadRoot: CHOSEN,
          externalPlayer: null,
          openAtLogin: false,
          torrentsFolder: null
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Choose' }))
    expect(await screen.findByText(/Kept torrent/u)).toBeTruthy()
    // A profile entry the reader could not use is shown rather than hidden.
    expect(screen.getByText(/Broken torrent/u)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Import' }))

    const report = await screen.findByRole('status')
    expect(report.textContent).toContain('Imported 1 torrent')
    expect(report.textContent).toContain('1 skipped by the reader')
    expect(onImported).toHaveBeenCalledOnce()
    // Only the importable entry is sent, and it names the chosen profile.
    expect(
      commands.filter(entry => entry.command === 'import-legacy-torrent')
    ).toEqual([
      {
        command: 'import-legacy-torrent',
        payload: {
          destinationRoot: CHOSEN,
          infoHash: 'a'.repeat(40),
          legacyRoot: CHOSEN
        }
      }
    ])
  })
})
