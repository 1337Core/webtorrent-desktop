import { useEffect, useState } from 'react'
import type { EngineStatus } from '../shared/contracts'

const runtime = window.webtorrentUpdated.getRuntimeInfo()

export function App(): React.JSX.Element {
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    state: 'starting'
  })

  useEffect(() => window.webtorrentUpdated.onEngineStatus(setEngineStatus), [])
  useEffect(() => {
    window.webtorrentUpdated.reportRendererReady()
  }, [])

  const statusLabel =
    engineStatus.state === 'ready'
      ? `WebTorrent ${engineStatus.webTorrentVersion} · native WebRTC ready`
      : engineStatus.state === 'failed'
        ? `Engine failed: ${engineStatus.message}`
        : 'Checking the native WebRTC engine…'

  return (
    <main>
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
            {runtime.architecture} · macOS · Electron {runtime.electronVersion}
          </p>
        </div>
        <span className={`status status-${engineStatus.state}`}>
          {statusLabel}
        </span>
      </section>
    </main>
  )
}
