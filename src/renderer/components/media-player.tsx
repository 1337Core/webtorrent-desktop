import { useCallback, useEffect, useRef, useState } from 'react'
import { runCommand, type EngineFailure } from '../lib/engine-client'

/** Well inside the engine's lease TTL, so playback never expires mid-file. */
const HEARTBEAT_MS = 20_000

export type MediaPlayerProps = Readonly<{
  fileIndex: number
  fileName: string
  infoHash: string
  onClose: () => void
}>

/**
 * Plays one selected file through the engine's loopback proxy.
 *
 * The renderer receives only an opaque per-file URL: no path, no torrent
 * index, and no WebTorrent server. The lease is refreshed while the element
 * is mounted and closed as soon as it unmounts.
 */
export function MediaPlayer({
  fileIndex,
  fileName,
  infoHash,
  onClose
}: MediaPlayerProps): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const leaseRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    const open = setTimeout(() => {
      void runCommand({
        command: 'open-media',
        payload: { fileIndex, infoHash }
      }).then(outcome => {
        if (!active) return
        if (!outcome.ok) {
          setFailure(outcome.error)
          return
        }
        leaseRef.current = outcome.value.leaseId
        setUrl(outcome.value.url)
      })
    }, 0)

    return () => {
      active = false
      clearTimeout(open)
      const leaseId = leaseRef.current
      leaseRef.current = null
      if (leaseId !== null) {
        void runCommand({ command: 'close-media', payload: { leaseId } })
      }
    }
  }, [fileIndex, infoHash])

  useEffect(() => {
    if (url === null) return undefined
    const timer = setInterval(() => {
      const leaseId = leaseRef.current
      if (leaseId === null) return
      void runCommand({
        command: 'heartbeat-media',
        payload: { leaseId }
      }).then(outcome => {
        if (!outcome.ok) setFailure(outcome.error)
      })
    }, HEARTBEAT_MS)
    return () => {
      clearInterval(timer)
    }
  }, [url])

  const close = useCallback(() => {
    setUrl(null)
    onClose()
  }, [onClose])

  return (
    <section aria-labelledby="player-heading" className="player">
      <h2 id="player-heading">{fileName}</h2>
      {url === null ? (
        <p className="summary">Opening the stream…</p>
      ) : (
        <video controls data-testid="media-element" src={url}>
          <track kind="captions" />
        </video>
      )}
      {failure ? (
        <p className="error" role="alert">
          {failure.displayMessage}
        </p>
      ) : null}
      <button onClick={close} type="button">
        Close player
      </button>
    </section>
  )
}
