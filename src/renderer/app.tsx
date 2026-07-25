import { useEffect, useState } from 'react'
import type { BootstrapSnapshot, EngineStatus } from '../shared/contracts'
import { AddTorrent } from './components/add-torrent'
import { CreateTorrent } from './components/create-torrent'
import { MediaPlayer } from './components/media-player'
import { Preferences } from './components/preferences'
import { TorrentList } from './components/torrent-list'

function engineLabel(status: EngineStatus): string {
  switch (status.state) {
    case 'ready':
      return `WebTorrent ${status.webTorrentVersion} · native WebRTC ready`
    case 'restarting':
      return 'Engine stopped unexpectedly · restarting once…'
    case 'stopped':
      return status.message
    case 'starting':
      return 'Checking the native WebRTC engine…'
  }
}

function hasPrivilegedRendererGlobal(): boolean {
  return ['Buffer', 'process', 'require'].some(name =>
    Reflect.has(globalThis, name)
  )
}

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
  const [restartPending, setRestartPending] = useState(false)
  const [listRevision, setListRevision] = useState(0)
  const [downloadRoot, setDownloadRoot] = useState<string | null>(null)
  const [openIntent, setOpenIntent] = useState<
    | { kind: 'magnet'; magnet: string }
    | { kind: 'torrent-file'; torrentPath: string }
    | null
  >(null)
  const [focused, setFocused] = useState<
    'add-torrent' | 'create-torrent' | 'preferences' | null
  >(null)
  const [playing, setPlaying] = useState<{
    fileIndex: number
    fileName: string
    infoHash: string
  } | null>(null)

  // A menu action only asks the renderer to surface a section; it never
  // performs the action itself.
  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onOpenIntent(setOpenIntent)
  }, [rendererBoundaryFailed])

  useEffect(() => {
    if (rendererBoundaryFailed) return undefined
    return window.desktop.onMenuAction(action => {
      setFocused(action)
      document.getElementById(`${action}-heading`)?.scrollIntoView({
        behavior: 'smooth'
      })
    })
  }, [rendererBoundaryFailed])

  useEffect(() => {
    let active = true
    if (rendererBoundaryFailed) {
      return () => {
        active = false
      }
    }

    const unsubscribe = window.desktop.onEngineStatus(status => {
      if (active) setEngineStatus(status)
    })

    void window.desktop.getBootstrap().then(result => {
      if (!active) return
      if (!result.ok) {
        setStartupError(result.error.displayMessage)
        return
      }

      setBootstrap(result.value)
      setDownloadRoot(result.value.state.preferences.downloadRoot)
      setEngineStatus(result.value.engineStatusEvent.status)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [rendererBoundaryFailed])

  async function restartEngine(): Promise<void> {
    setRestartPending(true)
    const result = await window.desktop.restartEngine()
    setRestartPending(false)
    if (result.ok) {
      setStartupError(null)
      setEngineStatus(result.value.status)
    } else {
      setStartupError(result.error.displayMessage)
    }
  }

  const statusLabel = engineLabel(engineStatus)

  return (
    <main
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
      <p className="eyebrow">Apple Silicon modernization</p>
      <h1>WebTorrent Updated</h1>
      <p className="summary">
        Apple Silicon build with a sandboxed renderer and a supervised torrent
        engine.
      </p>

      <section aria-labelledby="runtime-heading">
        <div>
          <h2 id="runtime-heading">Runtime</h2>
          <p>
            {bootstrap
              ? `${bootstrap.runtime.architecture} · macOS · Electron ${bootstrap.runtime.electronVersion}`
              : 'Loading main-owned runtime information…'}
          </p>
        </div>
        <div className="status-group">
          <span className={`status status-${engineStatus.state}`} role="status">
            {statusLabel}
          </span>
          {engineStatus.state === 'stopped' ? (
            <button
              disabled={restartPending}
              onClick={() => void restartEngine()}
              type="button"
            >
              {restartPending ? 'Restarting…' : 'Restart engine'}
            </button>
          ) : null}
        </div>
      </section>

      <div data-focused-section={focused ?? undefined}>
        <Preferences downloadRoot={downloadRoot} onChanged={setDownloadRoot} />
      </div>

      <AddTorrent
        downloadRoot={downloadRoot}
        intent={openIntent}
        onAdded={() => {
          setOpenIntent(null)
          setListRevision(revision => revision + 1)
        }}
        ready={engineStatus.state === 'ready'}
      />

      <CreateTorrent
        onCreated={() => setListRevision(revision => revision + 1)}
        ready={engineStatus.state === 'ready'}
      />

      <TorrentList
        active={engineStatus.state === 'ready'}
        key={listRevision}
        onPlay={setPlaying}
      />

      {playing ? (
        <MediaPlayer
          fileIndex={playing.fileIndex}
          fileName={playing.fileName}
          infoHash={playing.infoHash}
          onClose={() => setPlaying(null)}
        />
      ) : null}

      {startupError ? (
        <p className="error" role="alert">
          {startupError}
        </p>
      ) : null}
    </main>
  )
}
