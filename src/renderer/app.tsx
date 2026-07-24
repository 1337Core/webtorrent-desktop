import { useEffect, useState } from 'react'
import type { BootstrapSnapshot, EngineStatus } from '../shared/contracts'

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
        The secure Electron shell is running. Torrent controls will return as
        each migration milestone clears its tests.
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

      {startupError ? (
        <p className="error" role="alert">
          {startupError}
        </p>
      ) : null}
    </main>
  )
}
