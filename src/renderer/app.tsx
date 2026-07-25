import { useCallback, useEffect, useState } from 'react'
import type { BootstrapSnapshot, EngineStatus } from '../shared/contracts'
import { AddTorrentModal } from './components/add-torrent'
import { CreateTorrentPage } from './components/create-torrent'
import { Header } from './components/header'
import { MediaPlayer } from './components/media-player'
import { PreferencesPage } from './components/preferences'
import { TorrentList } from './components/torrent-list'
import { UnsupportedMediaModal } from './components/unsupported-media'

type Location = 'create-torrent' | 'home' | 'player' | 'preferences'

type Preferences = {
  downloadRoot: string | null
  externalPlayer: string | null
  torrentsFolder: string | null
}

type OpenIntent =
  | { kind: 'magnet'; magnet: string }
  | { kind: 'torrent-file'; torrentPath: string }

/** The original recognized a magnet link by its scheme alone. */
const MAGNET = /^magnet:\?/iu

type Playing = {
  fileIndex: number
  fileName: string
  infoHash: string
  playlist: ReadonlyArray<{ fileIndex: number; fileName: string }>
}

/** The original showed the player's own name on the unsupported-media modal. */
function externalPlayerName(playerPath: string | null): string | null {
  if (playerPath === null) return null
  const base = playerPath
    .split('/')
    .filter(part => part !== '')
    .at(-1)
  if (base === undefined) return null
  return base.replace(/\.app$/u, '')
}

const TITLES: Readonly<Record<Location, string>> = {
  'create-torrent': 'Create torrent',
  home: 'WebTorrent Updated',
  player: 'WebTorrent Updated',
  preferences: 'Preferences'
}

function hasPrivilegedRendererGlobal(): boolean {
  // The unit-test environment supplies the very Node globals this probe looks
  // for. Vite replaces the mode with a literal at build time, so the packaged
  // renderer always runs the real check and no page can turn it off.
  if (import.meta.env.MODE === 'test') return false
  return ['Buffer', 'process', 'require'].some(name =>
    Reflect.has(globalThis, name)
  )
}

/**
 * The application shell, laid out as the original: a header above one page of
 * content, with a modal over the top. The screens are the ones the original
 * had, minus the features section 4.2 removes.
 */
export function App(): React.JSX.Element {
  const rendererBoundaryFailed = hasPrivilegedRendererGlobal()
  const [bootstrap, setBootstrap] = useState<BootstrapSnapshot | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    state: 'starting',
    generationId: null,
    restartCount: 0
  })
  const [startupError, setStartupError] = useState<string | null>(() =>
    rendererBoundaryFailed
      ? 'The renderer trust boundary failed; torrent controls remain disabled.'
      : null
  )
  const [preferences, setPreferences] = useState<Preferences>({
    downloadRoot: null,
    externalPlayer: null,
    torrentsFolder: null
  })
  // The original navigated a history the header's chevrons walked, so the
  // location is a position in that history rather than a bare value.
  const [history, setHistory] = useState<{
    entries: ReadonlyArray<Location>
    index: number
  }>({ entries: ['home'], index: 0 })
  const location = history.entries[history.index] ?? 'home'
  const setLocation = useCallback((next: Location) => {
    setHistory(current => {
      if (current.entries[current.index] === next) return current
      const entries = [...current.entries.slice(0, current.index + 1), next]
      return { entries, index: entries.length - 1 }
    })
  }, [])
  const [modalOpen, setModalOpen] = useState(false)
  // A drop can carry several torrents; the original added every one, so they
  // queue and the modal reviews them in turn.
  const [intents, setIntents] = useState<ReadonlyArray<OpenIntent>>([])
  const openIntent = intents[0] ?? null
  const [playing, setPlaying] = useState<Playing | null>(null)
  const [unsupported, setUnsupported] = useState<{
    mediaUrl: string
    message: string
  } | null>(null)
  const [externalPlayerFailed, setExternalPlayerFailed] = useState(false)
  const [listRevision, setListRevision] = useState(0)
  const [focused, setFocused] = useState(true)
  const [fullScreen, setFullScreen] = useState(false)
  const [controlsHidden, setControlsHidden] = useState(false)
  const [externalSubtitleRequest, setExternalSubtitleRequest] = useState(0)

  // The original root carried the window's own state as classes, and the
  // stylesheet still keys the header and content off them.
  useEffect(() => {
    const sync = () => setFocused(document.hasFocus())
    const syncFullScreen = () =>
      setFullScreen(document.fullscreenElement !== null)
    sync()
    window.addEventListener('blur', sync)
    window.addEventListener('focus', sync)
    document.addEventListener('fullscreenchange', syncFullScreen)
    return () => {
      window.removeEventListener('blur', sync)
      window.removeEventListener('focus', sync)
      document.removeEventListener('fullscreenchange', syncFullScreen)
    }
  }, [])

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onEngineStatus(setEngineStatus)
  }, [rendererBoundaryFailed])

  const enqueueIntents = useCallback(
    (queued: ReadonlyArray<OpenIntent>) => {
      if (queued.length === 0) return
      setIntents(current => [...current, ...queued])
      setLocation('home')
      setModalOpen(true)
    },
    [setLocation]
  )

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onOpenIntent(intent => {
      enqueueIntents([intent])
    })
  }, [enqueueIntents, rendererBoundaryFailed])

  // The original accepted a dropped torrent file and a pasted magnet link,
  // exactly as its own placeholder still promises.
  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    const onPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text')?.trim() ?? ''
      if (!MAGNET.test(text)) return
      enqueueIntents([{ kind: 'magnet', magnet: text }])
    }
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('paste', onPaste)
    }
  }, [enqueueIntents, rendererBoundaryFailed])

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onMenuAction(action => {
      if (action === 'add-subtitles') {
        if (location === 'player' && playing !== null) {
          setExternalSubtitleRequest(request => request + 1)
        }
        return
      }
      if (action === 'add-torrent') {
        setLocation('home')
        setModalOpen(true)
        return
      }
      setLocation(action)
    })
  }, [location, playing, rendererBoundaryFailed, setLocation])

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    let active = true
    const timer = setTimeout(() => {
      void window.desktop.getBootstrap().then(result => {
        if (!active) return
        if (!result.ok) {
          setStartupError(result.error.displayMessage)
          return
        }
        setBootstrap(result.value)
        setPreferences(result.value.state.preferences)
        setEngineStatus(result.value.engineStatusEvent.status)
      })
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [rendererBoundaryFailed])

  const ready = engineStatus.state === 'ready'
  /** Retires the reviewed intent and keeps the modal open for the next one. */
  const closeModal = useCallback(() => {
    setIntents(current => {
      const remaining = current.slice(1)
      if (remaining.length === 0) setModalOpen(false)
      return remaining
    })
  }, [])
  const play = useCallback(
    (selection: Playing) => {
      setPlaying(selection)
      setLocation('player')
    },
    [setLocation]
  )

  // Leaving the player drops it from the history, so the forward chevron never
  // walks back into a page with nothing playing.
  const leavePlayer = useCallback(() => {
    setPlaying(null)
    setHistory(current => {
      const cut = current.entries.lastIndexOf('player')
      if (cut === -1) return current
      const entries = current.entries.slice(0, cut)
      return entries.length === 0
        ? { entries: ['home'], index: 0 }
        : { entries, index: entries.length - 1 }
    })
  }, [])

  // The lease belongs to the mounted player, so the page stays put while the
  // owner's own player takes over the same stream.
  const playExternally = useCallback(async () => {
    if (unsupported === null) return
    const launched = await window.desktop.openExternalPlayer(
      unsupported.mediaUrl
    )
    if (!launched.ok) {
      setExternalPlayerFailed(true)
      return
    }
    setExternalPlayerFailed(false)
    setUnsupported(null)
  }, [unsupported])

  return (
    <div
      className={[
        'app',
        'is-darwin',
        `view-${location}`,
        focused ? 'is-focused' : '',
        fullScreen ? 'is-fullscreen' : '',
        controlsHidden ? 'hide-video-controls' : ''
      ]
        .filter(name => name !== '')
        .join(' ')}
      data-bootstrap-ready={bootstrap !== null}
      data-engine-state={engineStatus.state}
      data-renderer-boundary={rendererBoundaryFailed ? 'failed' : 'passed'}
      onDragOver={event => {
        event.preventDefault()
      }}
      onDrop={event => {
        event.preventDefault()
        if (rendererBoundaryFailed) return
        const dropped = window.desktop
          .resolveDroppedTorrents(Array.from(event.dataTransfer.files))
          .map(torrentPath => ({ kind: 'torrent-file' as const, torrentPath }))
        const text = event.dataTransfer.getData('text').trim()
        enqueueIntents(
          MAGNET.test(text)
            ? [...dropped, { kind: 'magnet' as const, magnet: text }]
            : dropped
        )
      }}
    >
      <button
        aria-hidden="true"
        data-smoke-navigation-probe
        hidden
        onClick={() => {
          globalThis.location.href = 'app://bundle/not-allowed.html'
        }}
        tabIndex={-1}
        type="button"
      />

      <Header
        canGoBack={history.index > 0}
        canGoForward={history.index < history.entries.length - 1}
        onAdd={() => setModalOpen(true)}
        onBack={() => {
          if (location === 'player') {
            leavePlayer()
            return
          }
          setHistory(current => ({
            ...current,
            index: Math.max(0, current.index - 1)
          }))
        }}
        onForward={() =>
          setHistory(current => ({
            ...current,
            index: Math.min(current.entries.length - 1, current.index + 1)
          }))
        }
        showAdd={location === 'home'}
        title={TITLES[location]}
      />

      <div className={`error-popover ${startupError ? 'visible' : 'hidden'}`}>
        <div className="title">Error</div>
        {startupError ? <div className="error">{startupError}</div> : null}
      </div>

      <div className="content">
        {location === 'home' ? (
          <TorrentList active={ready} key={listRevision} onPlay={play} />
        ) : null}
        {location === 'create-torrent' ? (
          <CreateTorrentPage
            onCancel={() => setLocation('home')}
            onCreated={() => {
              setListRevision(revision => revision + 1)
              setLocation('home')
            }}
            ready={ready}
          />
        ) : null}
        {location === 'preferences' ? (
          <PreferencesPage
            onChanged={setPreferences}
            preferences={preferences}
          />
        ) : null}
        {location === 'player' && playing ? (
          <MediaPlayer
            externalSubtitleRequest={externalSubtitleRequest}
            fileIndex={playing.fileIndex}
            fileName={playing.fileName}
            infoHash={playing.infoHash}
            onClose={leavePlayer}
            onControlsHiddenChange={setControlsHidden}
            onSelectTrack={entry =>
              setPlaying(current =>
                current === null ? current : { ...current, ...entry }
              )
            }
            onUnsupported={setUnsupported}
            playlist={playing.playlist}
          />
        ) : null}
      </div>

      {modalOpen || unsupported !== null ? (
        <div className="modal">
          <div className="modal-background" />
          <div className="modal-content">
            {unsupported === null ? (
              <AddTorrentModal
                downloadRoot={preferences.downloadRoot}
                intent={openIntent}
                onAdded={() => {
                  setListRevision(revision => revision + 1)
                  closeModal()
                }}
                onCancel={closeModal}
                ready={ready}
              />
            ) : (
              <UnsupportedMediaModal
                externalPlayerFailed={externalPlayerFailed}
                externalPlayerName={externalPlayerName(
                  preferences.externalPlayer
                )}
                message={unsupported.message}
                onCancel={() => {
                  setUnsupported(null)
                  setExternalPlayerFailed(false)
                  leavePlayer()
                }}
                onPlayExternally={() => void playExternally()}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
