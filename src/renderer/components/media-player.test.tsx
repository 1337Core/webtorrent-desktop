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
import { MediaPlayer } from './media-player'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const LEASE_ID = '00000000-0000-4000-8000-000000000020'
const EXTERNAL_LEASE_IDS = [
  '00000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000031'
] as const
const MEDIA_URL = `http://127.0.0.1:52000/v1/media/${'a'.repeat(43)}`

let commands: EngineCommand[] = []
let failOpen = false
let onUnsupported = vi.fn()
let externalSubtitleCount = 0
let subtitleTracks: Array<{
  fileIndex: number
  label: string
  language: string
  leaseId: string
  url: string
}> = []

type FakeAudioTrack = {
  enabled: boolean
  label: string
  language: string
}

class FakeAudioTrackList {
  readonly [index: number]: FakeAudioTrack | undefined
  readonly #listeners = new Map<string, Set<EventListener>>()
  readonly #tracks: FakeAudioTrack[]

  constructor(tracks: FakeAudioTrack[]) {
    this.#tracks = tracks
    this.#reindex()
  }

  get length(): number {
    return this.#tracks.length
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.#listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener)
  }

  addTrack(track: FakeAudioTrack): void {
    this.#tracks.push(track)
    this.#reindex()
    this.#dispatch('addtrack')
  }

  removeTrack(index: number): void {
    this.#tracks.splice(index, 1)
    this.#reindex()
    this.#dispatch('removetrack')
  }

  change(): void {
    this.#dispatch('change')
  }

  listenerCount(): number {
    return [...this.#listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0
    )
  }

  #dispatch(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(new Event(type))
    }
  }

  #reindex(): void {
    for (let index = 0; index < 32; index += 1) {
      Reflect.deleteProperty(this, index)
    }
    for (const [index, track] of this.#tracks.entries()) {
      Object.defineProperty(this, index, {
        configurable: true,
        enumerable: true,
        value: track
      })
    }
  }
}

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
    case 'open-subtitles':
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'open-subtitles',
            value: {
              infoHash: INFO_HASH,
              tracks: subtitleTracks
            }
          }
        }
      } as TorrentCommandResult
    case 'open-external-subtitle': {
      const index = Math.min(
        externalSubtitleCount,
        EXTERNAL_LEASE_IDS.length - 1
      )
      const leaseId = EXTERNAL_LEASE_IDS[index] ?? EXTERNAL_LEASE_IDS[0]
      externalSubtitleCount += 1
      return {
        ...envelope,
        ok: true,
        value: {
          ok: true,
          result: {
            command: 'open-external-subtitle',
            value: {
              infoHash: INFO_HASH,
              mediaFileIndex: 1,
              track: {
                label: `External ${externalSubtitleCount}`,
                language: '',
                leaseId,
                url: `http://127.0.0.1:52000/v1/media/${index === 0 ? 'c'.repeat(43) : 'd'.repeat(43)}`
              }
            }
          }
        }
      } as TorrentCommandResult
    }
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
  externalSubtitleCount = 0
  onUnsupported = vi.fn()
  subtitleTracks = [
    {
      fileIndex: 2,
      label: 'English',
      language: 'en',
      leaseId: '00000000-0000-4000-8000-000000000021',
      url: `http://127.0.0.1:52000/v1/media/${'b'.repeat(43)}`
    }
  ]
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      choosePath: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          requestId: '00000000-0000-4000-8000-000000000005',
          ok: true,
          value: { path: '/tmp/captions.srt', summary: null }
        })
      ),
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
    expect(element).toHaveProperty('crossOrigin', 'anonymous')
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

  it('draws the original control bar', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Previous track' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Next track' })).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Enter full screen' })
    ).toBeDefined()
    expect(screen.getByLabelText('Volume')).toBeDefined()
    expect(screen.getByText('0:00 / 0:00')).toBeDefined()
    // The original never showed the browser's own controls.
    expect(screen.getByTestId('media-element').hasAttribute('controls')).toBe(
      false
    )
  })

  it('skips to the next playable file through the playlist', async () => {
    const user = userEvent.setup()
    const onSelectTrack = vi.fn()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
        onSelectTrack={onSelectTrack}
        playlist={[
          { fileIndex: 1, fileName: 'payload/second.bin' },
          { fileIndex: 2, fileName: 'payload/third.bin' }
        ]}
      />
    )
    await screen.findByTestId('media-element')

    await user.click(screen.getByRole('button', { name: 'Next track' }))
    expect(onSelectTrack).toHaveBeenCalledWith({
      fileIndex: 2,
      fileName: 'payload/third.bin'
    })
  })

  it('disables the skip controls with nothing to skip to', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
        playlist={[{ fileIndex: 1, fileName: 'payload/second.bin' }]}
      />
    )
    await screen.findByTestId('media-element')

    expect(
      screen.getByRole('button', { name: 'Next track' }).className
    ).toContain('disabled')
    expect(
      screen.getByRole('button', { name: 'Previous track' }).className
    ).toContain('disabled')
  })

  it('reports a refusal with the stream the owner can hand elsewhere', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
        onUnsupported={onUnsupported}
      />
    )
    const element = await screen.findByTestId('media-element')

    fireEvent.error(element)
    expect(onUnsupported).toHaveBeenCalledWith({
      mediaUrl: MEDIA_URL,
      message: 'payload/second.bin could not be played here.'
    })
  })

  it('hides the controls once the pointer sits still', async () => {
    const onControlsHiddenChange = vi.fn()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
        onControlsHiddenChange={onControlsHiddenChange}
      />
    )
    await screen.findByTestId('media-element')

    await waitFor(
      () => expect(onControlsHiddenChange).toHaveBeenCalledWith(true),
      { timeout: 4_000 }
    )

    fireEvent.mouseMove(document)
    expect(onControlsHiddenChange).toHaveBeenLastCalledWith(false)
  })

  it('returns to the list when the last track ends', async () => {
    const onClose = vi.fn()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={onClose}
      />
    )
    const element = await screen.findByTestId('media-element')

    fireEvent.ended(element)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("offers the torrent's subtitle tracks through the caption control", async () => {
    const user = userEvent.setup()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    await waitFor(() =>
      expect(
        commands.some(command => command.command === 'open-subtitles')
      ).toBe(true)
    )
    const caption = await screen.findByRole('button', {
      name: 'Closed captions'
    })
    await waitFor(() => expect(caption.className).not.toContain('disabled'))

    await user.click(caption)
    await user.click(await screen.findByText('English'))

    expect(caption.className).toContain('active')
    const track = document.querySelector('track')
    expect(track?.getAttribute('src')).toBe(subtitleTracks[0]?.url)
    expect(track?.getAttribute('srclang')).toBe('en')
  })

  it('leaves the caption control disabled with no subtitle to show', async () => {
    subtitleTracks = []
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')
    await waitFor(() =>
      expect(
        commands.some(command => command.command === 'open-subtitles')
      ).toBe(true)
    )

    expect(
      screen.getByRole('button', { name: 'Closed captions' }).className
    ).toContain('disabled')
    expect(document.querySelector('track')).toBeNull()
  })

  it('does not reopen the subtitle chooser when remounted with an old request', async () => {
    const first = render(
      <MediaPlayer
        externalSubtitleRequest={4}
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')
    first.unmount()

    render(
      <MediaPlayer
        externalSubtitleRequest={4}
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    expect(window.desktop.choosePath).not.toHaveBeenCalled()
  })

  it('closes the prior external subtitle lease when replacing it', async () => {
    subtitleTracks = []
    const { rerender } = render(
      <MediaPlayer
        externalSubtitleRequest={0}
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await screen.findByTestId('media-element')

    rerender(
      <MediaPlayer
        externalSubtitleRequest={1}
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(
        commands.filter(command => command.command === 'open-external-subtitle')
      ).toHaveLength(1)
    )
    rerender(
      <MediaPlayer
        externalSubtitleRequest={2}
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(
        commands.some(
          command =>
            command.command === 'close-media' &&
            command.payload.leaseId === EXTERNAL_LEASE_IDS[0]
        )
      ).toBe(true)
    )
    expect(document.querySelectorAll('track')).toHaveLength(1)
    expect(document.querySelector('track')?.getAttribute('src')).toContain(
      'd'.repeat(43)
    )
  })

  it('omits audio-track controls when the runtime exposes no track API', async () => {
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    const element = await screen.findByTestId('media-element')

    fireEvent.loadedMetadata(element)

    expect(screen.queryByRole('button', { name: 'Audio tracks' })).toBeNull()
  })

  it('selects among audio tracks when the runtime exposes more than one', async () => {
    const tracks = [
      { enabled: true, label: 'English', language: 'en' },
      { enabled: false, label: 'French', language: 'fr' }
    ]
    const user = userEvent.setup()
    render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    const element = await screen.findByTestId('media-element')
    Object.defineProperty(element, 'audioTracks', {
      configurable: true,
      value: tracks
    })

    fireEvent.loadedMetadata(element)
    const control = await screen.findByRole('button', {
      name: 'Audio tracks'
    })
    await user.click(control)
    await user.click(await screen.findByText('French'))

    expect(tracks).toEqual([
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ enabled: true })
    ])
  })

  it('tracks late audio-track list changes and removes its listeners', async () => {
    const tracks = [
      { enabled: true, label: 'English', language: 'en' },
      { enabled: false, label: 'French', language: 'fr' }
    ]
    const list = new FakeAudioTrackList(tracks.slice(0, 1))
    const user = userEvent.setup()
    const view = render(
      <MediaPlayer
        fileIndex={1}
        fileName="payload/second.bin"
        infoHash={INFO_HASH}
        onClose={vi.fn()}
      />
    )
    const element = await screen.findByTestId('media-element')
    Object.defineProperty(element, 'audioTracks', {
      configurable: true,
      value: list
    })

    fireEvent.loadedMetadata(element)
    expect(list.listenerCount()).toBe(3)
    expect(screen.queryByRole('button', { name: 'Audio tracks' })).toBeNull()

    act(() => list.addTrack(tracks[1] as FakeAudioTrack))
    const control = await screen.findByRole('button', { name: 'Audio tracks' })

    act(() => {
      tracks[0]!.enabled = false
      tracks[1]!.enabled = true
      list.change()
    })
    await user.click(control)
    expect(screen.getByText('French').textContent).toContain(
      'radio_button_checked'
    )

    act(() => list.removeTrack(1))
    expect(screen.queryByRole('button', { name: 'Audio tracks' })).toBeNull()

    view.unmount()
    expect(list.listenerCount()).toBe(0)
  })
})
