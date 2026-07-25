import { useCallback, useEffect, useState } from 'react'
import type { BootstrapSnapshot, EngineStatus } from '../shared/contracts'
import { AddTorrentModal } from './components/add-torrent'
import { CreateTorrentPage } from './components/create-torrent'
import { Header } from './components/header'
import { MediaPlayer } from './components/media-player'
import { PreferencesPage } from './components/preferences'
import { TorrentList } from './components/torrent-list'

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
  const [listRevision, setListRevision] = useState(0)

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

  return (
    <div
      className="app is-darwin"
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
            externalPlayerConfigured={preferences.externalPlayer !== null}
            fileIndex={playing.fileIndex}
            fileName={playing.fileName}
            infoHash={playing.infoHash}
            onClose={() => {
              setPlaying(null)
              setLocation('home')
            }}
          />
        ) : null}
      </div>

      {modalOpen ? (
        <div className="modal">
          <div className="modal-background" />
          <div className="modal-content">
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
          </div>
        </div>
      ) : null}
    </div>
  )
}
