import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTime, prettyBytes } from '../lib/format'
import { runCommand, type EngineFailure } from '../lib/engine-client'

/** Well inside the engine's lease TTL, so playback never expires mid-file. */
const HEARTBEAT_MS = 20_000
/** How often the stall overlay and loading bar refresh their figures. */
const PROGRESS_MS = 2_000
/** The original treated playback with no time update for this long as stalled. */
const STALLED_MS = 2_000
/** How long the pointer must sit still before the controls fade out. */
const CONTROLS_IDLE_MS = 2_000
const PAGE_LIMIT = 64

type PlaylistEntry = Readonly<{
  fileIndex: number
  fileName: string
}>

export type MediaPlayerProps = Readonly<{
  fileIndex: number
  fileName: string
  infoHash: string
  /** Every playable file of the torrent, in the order the list showed them. */
  playlist?: ReadonlyArray<PlaylistEntry>
  onClose: () => void
  /** Mirrors the original's `hide-video-controls` class on the app root. */
  onControlsHiddenChange?: (hidden: boolean) => void
  onSelectTrack?: (entry: PlaylistEntry) => void
  /**
   * Raised when the media element refuses the file, as the original did. The
   * minted URL travels with it so the owner's own player can take the stream
   * over without a second lease.
   */
  onUnsupported?: (
    refusal: Readonly<{ mediaUrl: string; message: string }>
  ) => void
}>

function volumeIconName(volume: number): string {
  if (volume === 0) return 'volume_off'
  if (volume < 0.3) return 'volume_mute'
  if (volume < 0.6) return 'volume_down'
  return 'volume_up'
}

/**
 * The original player: the video letterboxed over a black page, with the
 * control bar the original drew itself — playback bar, previous, play/pause,
 * next, volume, elapsed time, and full screen.
 *
 * Playback still runs through the engine's loopback proxy, so the renderer
 * receives only an opaque per-file URL: no path, no torrent index, and no
 * WebTorrent server. The lease is refreshed while the element is mounted and
 * closed as soon as it unmounts.
 */
export function MediaPlayer({
  fileIndex,
  fileName,
  infoHash,
  playlist = [],
  onClose,
  onControlsHiddenChange,
  onSelectTrack,
  onUnsupported
}: MediaPlayerProps): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [paused, setPaused] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [stalled, setStalled] = useState(false)
  const [fileProgress, setFileProgress] = useState(0)
  const [speeds, setSpeeds] = useState({ download: 0, upload: 0 })
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const leaseRef = useRef<string | null>(null)
  const lastUpdateRef = useRef(0)

  const position = playlist.findIndex(entry => entry.fileIndex === fileIndex)
  const previous = position > 0 ? playlist[position - 1] : undefined
  const next =
    position >= 0 && position < playlist.length - 1
      ? playlist[position + 1]
      : undefined

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

  // The loading bar and the stall overlay report the same figures the original
  // read straight off the torrent.
  useEffect(() => {
    if (url === null) return undefined
    let active = true

    const sample = async () => {
      const [files, torrents] = await Promise.all([
        runCommand({
          command: 'get-torrent-files',
          payload: { cursor: 0, infoHash, limit: PAGE_LIMIT }
        }),
        runCommand({
          command: 'list-torrents',
          payload: { cursor: 0, limit: PAGE_LIMIT }
        })
      ])
      if (!active) return
      if (files.ok) {
        const file = files.value.items.find(item => item.index === fileIndex)
        if (file) setFileProgress(file.progress)
      }
      if (torrents.ok) {
        const torrent = torrents.value.items.find(
          item => item.infoHash === infoHash
        )
        if (torrent) {
          setSpeeds({
            download: torrent.downloadSpeed,
            upload: torrent.uploadSpeed
          })
        }
      }
      if (active) {
        setStalled(
          !mediaRef.current?.paused &&
            performance.now() - lastUpdateRef.current > STALLED_MS
        )
      }
    }

    const first = setTimeout(() => void sample(), 0)
    const timer = setInterval(() => void sample(), PROGRESS_MS)
    return () => {
      active = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [fileIndex, infoHash, url])

  // The original hid the header and the control bar once the pointer had been
  // still for two seconds, unless playback was paused or the pointer was over
  // the controls themselves.
  const inControls = useRef(false)
  useEffect(() => {
    if (paused) {
      onControlsHiddenChange?.(false)
      return undefined
    }
    let timer = setTimeout(() => {
      if (!inControls.current) onControlsHiddenChange?.(true)
    }, CONTROLS_IDLE_MS)
    const moved = () => {
      onControlsHiddenChange?.(false)
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!inControls.current) onControlsHiddenChange?.(true)
      }, CONTROLS_IDLE_MS)
    }
    document.addEventListener('mousemove', moved)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousemove', moved)
      onControlsHiddenChange?.(false)
    }
  }, [onControlsHiddenChange, paused])

  const playPause = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) void media.play().catch(() => undefined)
    else media.pause()
  }, [])

  const toggleFullScreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else
      void document.documentElement.requestFullscreen().catch(() => undefined)
  }, [])

  const changeVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next))
    setVolume(clamped)
    if (mediaRef.current) mediaRef.current.volume = clamped
  }, [])

  const scrubTo = useCallback(
    (clientX: number) => {
      const media = mediaRef.current
      if (!media || !Number.isFinite(duration) || duration <= 0) return
      const fraction = clientX / document.body.clientWidth
      media.currentTime = Math.min(1, Math.max(0, fraction)) * duration
    },
    [duration]
  )

  const positionPercent =
    Number.isFinite(duration) && duration > 0
      ? (100 * currentTime) / duration
      : 0

  return (
    <div
      className="player"
      onWheel={event => changeVolume(volume + -event.deltaY / 500)}
    >
      <div className="letterbox">
        {url === null ? null : (
          // Subtitle tracks arrive with the subtitle feature; none exist yet.
          <video
            data-testid="media-element"
            onClick={playPause}
            onDoubleClick={toggleFullScreen}
            onEnded={() => (next ? onSelectTrack?.(next) : onClose())}
            onError={() =>
              onUnsupported?.({
                mediaUrl: url,
                message: `${fileName} could not be played here.`
              })
            }
            onLoadedMetadata={event => {
              setDuration(event.currentTarget.duration)
              setVolume(event.currentTarget.volume)
            }}
            onPause={() => setPaused(true)}
            onPlay={() => setPaused(false)}
            onStalled={() => setStalled(true)}
            onTimeUpdate={event => {
              lastUpdateRef.current = performance.now()
              setStalled(false)
              setCurrentTime(event.currentTarget.currentTime)
            }}
            ref={mediaRef}
            src={url}
          />
        )}

        {stalled || url === null ? (
          <div className="media-overlay-background">
            <div className="media-overlay">
              <div className="media-stalled">
                <div className="loading-spinner" />
                <div className="loading-status ellipsis">
                  <span>
                    <span className="progress">
                      {`${Math.floor(100 * fileProgress)}%`}
                    </span>
                    {' downloaded'}
                  </span>
                  <span>{` ↓ ${prettyBytes(speeds.download)}/s`}</span>
                  <span>{` ↑ ${prettyBytes(speeds.upload)}/s`}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {failure ? (
          <div className="media-overlay-background">
            <div className="media-overlay">
              <div className="error-text" role="alert">
                {failure.displayMessage}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div
        className="controls"
        onMouseEnter={() => {
          inControls.current = true
          onControlsHiddenChange?.(false)
        }}
        onMouseLeave={() => {
          inControls.current = false
        }}
      >
        <div className="playback-bar">
          <div className="loading-bar">
            <div
              className="loading-bar-part"
              style={{ left: '0%', width: `${100 * fileProgress}%` }}
            />
          </div>
          <div
            className="playback-cursor"
            style={{ left: `calc(${positionPercent}% - 3px)` }}
          />
          <div
            className="scrub-bar"
            draggable="true"
            onClick={event => scrubTo(event.clientX)}
            onDrag={event => event.clientX && scrubTo(event.clientX)}
            onDragStart={event => {
              event.dataTransfer.effectAllowed = 'none'
            }}
          />
        </div>

        <i
          aria-label="Previous track"
          className={`icon skip-previous float-left ${previous ? '' : 'disabled'}`}
          onClick={() => previous && onSelectTrack?.(previous)}
          role="button"
        >
          skip_previous
        </i>

        <i
          aria-label={paused ? 'Play' : 'Pause'}
          className="icon play-pause float-left"
          onClick={playPause}
          role="button"
        >
          {paused ? 'play_arrow' : 'pause'}
        </i>

        <i
          aria-label="Next track"
          className={`icon skip-next float-left ${next ? '' : 'disabled'}`}
          onClick={() => next && onSelectTrack?.(next)}
          role="button"
        >
          skip_next
        </i>

        <i
          aria-label="Enter full screen"
          className="icon fullscreen float-right"
          onClick={toggleFullScreen}
          role="button"
        >
          fullscreen
        </i>

        <div className="volume float-left">
          <i
            aria-label="Mute"
            className="icon volume-icon float-left"
            onMouseDown={() => changeVolume(volume === 0 ? 1 : 0)}
            role="button"
          >
            {volumeIconName(volume)}
          </i>
          <input
            aria-label="Volume"
            className="volume-slider float-right"
            max="1"
            min="0"
            onChange={event => changeVolume(Number(event.target.value))}
            step="0.05"
            style={{
              background: `linear-gradient(to right, #eee ${volume * 100}%, #727272 ${volume * 100}%)`
            }}
            type="range"
            value={volume}
          />
        </div>

        <span className="time float-left">
          {`${formatTime(currentTime, duration)} / ${formatTime(duration, duration)}`}
        </span>
      </div>
    </div>
  )
}
