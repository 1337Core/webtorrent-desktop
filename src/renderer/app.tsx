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
  const [location, setLocation] = useState<Location>('home')
  const [modalOpen, setModalOpen] = useState(false)
  const [openIntent, setOpenIntent] = useState<
    | { kind: 'magnet'; magnet: string }
    | { kind: 'torrent-file'; torrentPath: string }
    | null
  >(null)
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

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onOpenIntent(intent => {
      setOpenIntent(intent)
      setLocation('home')
      setModalOpen(true)
    })
  }, [rendererBoundaryFailed])

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onMenuAction(action => {
      if (action === 'add-torrent') {
        setLocation('home')
        setModalOpen(true)
        return
      }
      setLocation(action)
    })
  }, [rendererBoundaryFailed])

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
  const closeModal = useCallback(() => {
    setModalOpen(false)
    setOpenIntent(null)
  }, [])
  const play = useCallback((selection: Playing) => {
    setPlaying(selection)
    setLocation('player')
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
      data-renderer-boundary={rendererBoundaryFailed ? 'failed' : 'passed'}
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
        canGoBack={location !== 'home'}
        onAdd={() => setModalOpen(true)}
        onBack={() => {
          setPlaying(null)
          setLocation('home')
        }}
        showAdd={location === 'home' && ready}
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
            fileIndex={playing.fileIndex}
            fileName={playing.fileName}
            infoHash={playing.infoHash}
            onClose={() => {
              setPlaying(null)
              setLocation('home')
            }}
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
                  setPlaying(null)
                  setLocation('home')
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
