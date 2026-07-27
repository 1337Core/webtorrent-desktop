import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTime, prettyBytes } from '../lib/format'
import {
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

/** Well inside the engine's lease TTL, so playback never expires mid-file. */
const HEARTBEAT_MS = 20_000
/** How often the stall overlay and loading bar refresh their figures. */
const PROGRESS_MS = 2_000
/** The original treated playback with no time update for this long as stalled. */
const STALLED_MS = 2_000
/** How long the pointer must sit still before the controls fade out. */
const CONTROLS_IDLE_MS = 2_000
const PAGE_LIMIT = 64
const AUDIO_FILE = /\.(m4a|m4b|m4p|mp3|oga|ogg|opus|wav)$/iu

type EmbeddedAudioTrack = {
  enabled: boolean
  label: string
  language: string
}

type EmbeddedAudioTrackList = {
  addEventListener?: (type: string, listener: EventListener) => void
  readonly length: number
  removeEventListener?: (type: string, listener: EventListener) => void
  readonly [index: number]: EmbeddedAudioTrack | undefined
}

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
  /** Incremented when the native File menu asks this player for subtitles. */
  externalSubtitleRequest?: number
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
 * Starts an element playing without assuming the request can be honored.
 *
 * A runtime may refuse with a rejected promise, and one without media support
 * throws outright, so both are treated as still paused rather than as an error
 * the owner has to see.
 */
function startPlayback(
  media: HTMLVideoElement,
  onRefused: () => void = () => undefined
): void {
  try {
    const started: unknown = media.play()
    if (started instanceof Promise) started.catch(onRefused)
  } catch {
    onRefused()
  }
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
  externalSubtitleRequest = 0,
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
  const [subtitles, setSubtitles] = useState<
    ReadonlyArray<
      Readonly<{
        label: string
        language: string
        leaseId: string
        url: string
      }>
    >
  >([])
  const [subtitleIndex, setSubtitleIndex] = useState(-1)
  const [subtitleMenuOpen, setSubtitleMenuOpen] = useState(false)
  const [audioTrackMenuOpen, setAudioTrackMenuOpen] = useState(false)
  const [audioTracks, setAudioTracks] = useState<
    ReadonlyArray<
      Readonly<{ label: string; language: string; nativeIndex: number }>
    >
  >([])
  const [audioTrackIndex, setAudioTrackIndex] = useState(0)
  const [audioInfo, setAudioInfo] =
    useState<EngineValue<'open-audio-metadata'> | null>(null)
  const mediaRef = useRef<HTMLVideoElement | null>(null)
  const leaseIdsRef = useRef(new Set<string>())
  const externalSubtitleLeaseRef = useRef<string | null>(null)
  const externalSubtitleRequestRef = useRef(externalSubtitleRequest)
  const lastUpdateRef = useRef(0)
  const playbackEpochRef = useRef(0)
  const audioTrackCleanupRef = useRef<() => void>(() => undefined)

  const position = playlist.findIndex(entry => entry.fileIndex === fileIndex)
  const previous = position > 0 ? playlist[position - 1] : undefined
  const next =
    position >= 0 && position < playlist.length - 1
      ? playlist[position + 1]
      : undefined

  useEffect(() => {
    const playbackEpoch = playbackEpochRef.current + 1
    playbackEpochRef.current = playbackEpoch
    const playbackLeaseIds = new Set<string>()
    leaseIdsRef.current = playbackLeaseIds
    let active = true
    const open = setTimeout(() => {
      setUrl(null)
      setFailure(null)
      setSubtitles([])
      setSubtitleIndex(-1)
      setAudioInfo(null)
      setAudioTracks([])
      void runCommand({
        command: 'open-media',
        payload: { fileIndex, infoHash }
      }).then(outcome => {
        if (!active) {
          if (outcome.ok) {
            void runCommand({
              command: 'close-media',
              payload: { leaseId: outcome.value.leaseId }
            })
          }
          return
        }
        if (!outcome.ok) {
          setFailure(outcome.error)
          return
        }
        playbackLeaseIds.add(outcome.value.leaseId)
        setUrl(outcome.value.url)
      })
    }, 0)

    return () => {
      active = false
      if (playbackEpochRef.current === playbackEpoch) {
        playbackEpochRef.current += 1
      }
      clearTimeout(open)
      for (const leaseId of playbackLeaseIds) {
        void runCommand({ command: 'close-media', payload: { leaseId } })
      }
      playbackLeaseIds.clear()
      externalSubtitleLeaseRef.current = null
    }
  }, [fileIndex, infoHash])

  useEffect(() => {
    if (url === null) return undefined
    const timer = setInterval(() => {
      for (const leaseId of leaseIdsRef.current) {
        void runCommand({
          command: 'heartbeat-media',
          payload: { leaseId }
        }).then(outcome => {
          if (!outcome.ok) setFailure(outcome.error)
        })
      }
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

  // The original looked for the torrent's own subtitle files as soon as a
  // video started; the engine converts them and serves each one by URL.
  useEffect(() => {
    if (url === null) return undefined
    let active = true
    const timer = setTimeout(() => {
      void runCommand({
        command: 'open-subtitles',
        payload: { infoHash }
      }).then(outcome => {
        if (!outcome.ok) return
        if (!active) {
          for (const track of outcome.value.tracks) {
            void runCommand({
              command: 'close-media',
              payload: { leaseId: track.leaseId }
            })
          }
          return
        }
        for (const track of outcome.value.tracks) {
          leaseIdsRef.current.add(track.leaseId)
        }
        setSubtitles(outcome.value.tracks)
      })
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [infoHash, url])

  useEffect(() => {
    if (url === null || !AUDIO_FILE.test(fileName)) return undefined
    let active = true
    const timer = setTimeout(() => {
      void runCommand({
        command: 'open-audio-metadata',
        payload: { fileIndex, infoHash }
      }).then(outcome => {
        if (!outcome.ok) return
        const artworkLease = outcome.value.artwork?.leaseId
        if (!active) {
          if (artworkLease) {
            void runCommand({
              command: 'close-media',
              payload: { leaseId: artworkLease }
            })
          }
          return
        }
        if (artworkLease) leaseIdsRef.current.add(artworkLease)
        setAudioInfo(outcome.value)
      })
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [fileIndex, fileName, infoHash, url])

  const openExternalSubtitle = useCallback(async () => {
    const playbackEpoch = playbackEpochRef.current
    const chosen = await window.desktop.choosePath('subtitle')
    if (
      playbackEpoch !== playbackEpochRef.current ||
      !chosen.ok ||
      chosen.value.path === null
    ) {
      return
    }
    const outcome = await runCommand({
      command: 'open-external-subtitle',
      payload: {
        infoHash,
        mediaFileIndex: fileIndex,
        path: chosen.value.path
      }
    })
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    if (playbackEpoch !== playbackEpochRef.current) {
      void runCommand({
        command: 'close-media',
        payload: { leaseId: outcome.value.track.leaseId }
      })
      return
    }
    const previousLease = externalSubtitleLeaseRef.current
    if (previousLease) {
      leaseIdsRef.current.delete(previousLease)
      void runCommand({
        command: 'close-media',
        payload: { leaseId: previousLease }
      })
    }
    externalSubtitleLeaseRef.current = outcome.value.track.leaseId
    leaseIdsRef.current.add(outcome.value.track.leaseId)
    setSubtitles(current => {
      const next = [
        ...current.filter(track => track.leaseId !== previousLease),
        outcome.value.track
      ]
      setSubtitleIndex(next.length - 1)
      return next
    })
    setSubtitleMenuOpen(false)
  }, [fileIndex, infoHash])

  useEffect(() => {
    if (
      externalSubtitleRequest <= 0 ||
      externalSubtitleRequest === externalSubtitleRequestRef.current
    ) {
      return
    }
    externalSubtitleRequestRef.current = externalSubtitleRequest
    void openExternalSubtitle()
  }, [externalSubtitleRequest, openExternalSubtitle])

  const syncAudioTracks = useCallback((list: EmbeddedAudioTrackList) => {
    const tracks: Array<{
      label: string
      language: string
      nativeIndex: number
    }> = []
    let selected = 0
    for (let index = 0; index < Math.min(list.length, 32); index += 1) {
      const track = list[index]
      if (!track) continue
      if (track.enabled) selected = index
      tracks.push({
        label: (track.label || `Track ${index + 1}`).slice(0, 64),
        language: (track.language || '').slice(0, 16),
        nativeIndex: index
      })
    }
    setAudioTrackIndex(selected)
    setAudioTracks(tracks.length > 1 ? tracks : [])
  }, [])

  const bindAudioTracks = useCallback(
    (media: HTMLVideoElement) => {
      audioTrackCleanupRef.current()
      audioTrackCleanupRef.current = () => undefined
      const candidate = Reflect.get(media, 'audioTracks') as unknown
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        !('length' in candidate) ||
        typeof candidate.length !== 'number'
      ) {
        setAudioTracks([])
        return
      }
      const list = candidate as EmbeddedAudioTrackList
      const refresh: EventListener = () => syncAudioTracks(list)
      syncAudioTracks(list)
      if (
        typeof list.addEventListener !== 'function' ||
        typeof list.removeEventListener !== 'function'
      ) {
        return
      }
      const events = ['addtrack', 'removetrack', 'change'] as const
      for (const event of events) list.addEventListener(event, refresh)
      audioTrackCleanupRef.current = () => {
        for (const event of events) list.removeEventListener?.(event, refresh)
      }
    },
    [syncAudioTracks]
  )

  const setMediaElement = useCallback((media: HTMLVideoElement | null) => {
    if (media === null) {
      audioTrackCleanupRef.current()
      audioTrackCleanupRef.current = () => undefined
    }
    mediaRef.current = media
  }, [])

  const selectAudioTrack = useCallback((selected: number) => {
    const media = mediaRef.current
    if (!media) return
    const candidate = Reflect.get(media, 'audioTracks') as unknown
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('length' in candidate) ||
      typeof candidate.length !== 'number'
    ) {
      return
    }
    const list = candidate as EmbeddedAudioTrackList
    for (let index = 0; index < list.length; index += 1) {
      const track = list[index]
      if (track) track.enabled = index === selected
    }
    setAudioTrackIndex(selected)
    setAudioTrackMenuOpen(false)
  }, [])

  // Only the chosen track shows; the rest stay loaded but hidden, as the
  // original's track handling did.
  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    for (let index = 0; index < media.textTracks.length; index += 1) {
      const track = media.textTracks[index]
      if (track) track.mode = index === subtitleIndex ? 'showing' : 'hidden'
    }
  }, [subtitleIndex, subtitles])

  /**
   * Choosing a file is the request to play it. The element is mounted only
   * once its lease URL exists, so playback starts here rather than through an
   * `autoPlay` attribute that would race the assignment. A refused promise
   * leaves the element paused and the controls follow through `onPause`.
   */
  useEffect(() => {
    if (url === null) return
    const media = mediaRef.current
    if (!media) return
    startPlayback(media, () => setPaused(true))
  }, [url])

  const playPause = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) startPlayback(media)
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
            crossOrigin="anonymous"
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
              bindAudioTracks(event.currentTarget)
            }}
            onPause={() => setPaused(true)}
            onPlay={() => setPaused(false)}
            onStalled={() => setStalled(true)}
            onTimeUpdate={event => {
              lastUpdateRef.current = performance.now()
              setStalled(false)
              setCurrentTime(event.currentTarget.currentTime)
            }}
            ref={setMediaElement}
            src={url}
          >
            {subtitles.map((track, index) => (
              <track
                default={index === subtitleIndex}
                key={track.url}
                kind="subtitles"
                label={track.label}
                src={track.url}
                {...(track.language === '' ? {} : { srcLang: track.language })}
              />
            ))}
          </video>
        )}

        {audioInfo ? (
          <div className="media-overlay-background audio-info-background">
            {audioInfo.artwork ? (
              <img
                alt=""
                className="audio-artwork"
                height={audioInfo.artwork.height}
                src={audioInfo.artwork.url}
                width={audioInfo.artwork.width}
              />
            ) : null}
            <div className="audio-metadata">
              <div className="audio-title">{audioInfo.metadata.title}</div>
              {audioInfo.metadata.artist ? (
                <div className="audio-artist">
                  <label>Artist</label>
                  {audioInfo.metadata.artist}
                </div>
              ) : null}
              {audioInfo.metadata.album ? (
                <div className="audio-album">
                  <label>Album</label>
                  {audioInfo.metadata.album}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

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

        <i
          aria-label="Closed captions"
          className={`icon closed-caption float-right ${
            subtitles.length === 0
              ? 'disabled'
              : subtitleIndex >= 0
                ? 'active'
                : ''
          }`}
          onClick={() => {
            if (subtitles.length === 0) {
              void openExternalSubtitle()
              return
            }
            setAudioTrackMenuOpen(false)
            setSubtitleMenuOpen(open => !open)
          }}
          role="button"
        >
          closed_caption
        </i>

        {audioTracks.length > 1 ? (
          <i
            aria-label="Audio tracks"
            className="icon multi-audio float-right active"
            onClick={() => {
              setSubtitleMenuOpen(false)
              setAudioTrackMenuOpen(open => !open)
            }}
            role="button"
          >
            library_music
          </i>
        ) : null}

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

        {subtitleMenuOpen && subtitles.length > 0 ? (
          <ul className="options-list">
            {subtitles.map((track, index) => (
              <li
                key={track.url}
                onClick={() => {
                  setSubtitleIndex(index)
                  setSubtitleMenuOpen(false)
                }}
              >
                <i className="icon">
                  {`radio_button_${index === subtitleIndex ? 'checked' : 'unchecked'}`}
                </i>
                {track.label}
              </li>
            ))}
            <li
              onClick={() => {
                setSubtitleIndex(-1)
                setSubtitleMenuOpen(false)
              }}
            >
              <i className="icon">
                {`radio_button_${subtitleIndex === -1 ? 'checked' : 'unchecked'}`}
              </i>
              None
            </li>
          </ul>
        ) : null}

        {audioTrackMenuOpen && audioTracks.length > 1 ? (
          <ul className="options-list">
            {audioTracks.map(track => (
              <li
                key={`${track.language}:${track.label}:${track.nativeIndex}`}
                onClick={() => selectAudioTrack(track.nativeIndex)}
              >
                <i className="icon">
                  {`radio_button_${track.nativeIndex === audioTrackIndex ? 'checked' : 'unchecked'}`}
                </i>
                {track.label}
              </li>
            ))}
          </ul>
        ) : null}

        <span className="time float-left">
          {`${formatTime(currentTime, duration)} / ${formatTime(duration, duration)}`}
        </span>
      </div>
    </div>
  )
}
