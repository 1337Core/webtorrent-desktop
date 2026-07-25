import { useCallback, useEffect, useRef, useState } from 'react'
import { calculateEta, prettyBytes } from '../lib/format'
import {
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

const TORRENT_LIST_REFRESH_MS = 1_000
const PAGE_LIMIT = 64
const PLAYABLE = /\.(m4a|m4b|m4p|m4v|mkv|mov|mp3|mp4|ogg|wav|webm)$/iu

type TorrentSummary = EngineValue<'list-torrents'>['items'][number]
type TorrentFile = EngineValue<'get-torrent-files'>['items'][number]

function statusLabel(torrent: TorrentSummary): string {
  switch (torrent.state) {
    case 'checking':
      return 'Verifying'
    case 'downloading':
      return 'Downloading'
    case 'error':
      return 'Error'
    case 'paused':
      return torrent.progress === 1 ? 'Not seeding' : 'Paused'
    case 'seeding':
      return 'Seeding'
    case 'stopped':
      return ''
  }
}

export type TorrentListProps = Readonly<{
  active: boolean
  onPlay: (
    selection: Readonly<{
      fileIndex: number
      fileName: string
      infoHash: string
      /** Every playable file of the torrent, so the player can skip tracks. */
      playlist: ReadonlyArray<Readonly<{ fileIndex: number; fileName: string }>>
    }>
  ) => void
  refreshMs?: number
}>

/**
 * The original torrent list: one row per torrent with its name, a download
 * checkbox, status, progress bar and figures, and the remove control,
 * expanding to the file table when the row is selected.
 */
export function TorrentList({
  active,
  onPlay,
  refreshMs = TORRENT_LIST_REFRESH_MS
}: TorrentListProps): React.JSX.Element {
  const [torrents, setTorrents] = useState<ReadonlyArray<TorrentSummary>>([])
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<ReadonlyArray<TorrentFile>>([])
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const outcome = await runCommand({
      command: 'list-torrents',
      payload: { cursor: 0, limit: PAGE_LIMIT }
    })
    if (!mounted.current) return
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setFailure(null)
    setTorrents(outcome.value.items)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!active) return undefined
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), refreshMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active, refresh, refreshMs])

  const select = useCallback(
    async (infoHash: string) => {
      if (selected === infoHash) {
        setSelected(null)
        setFiles([])
        return
      }
      const outcome = await runCommand({
        command: 'get-torrent-files',
        payload: { cursor: 0, infoHash, limit: PAGE_LIMIT }
      })
      if (!mounted.current) return
      if (!outcome.ok) {
        setFailure(outcome.error)
        return
      }
      setSelected(infoHash)
      setFiles(outcome.value.items)
    },
    [selected]
  )

  const act = useCallback(
    async (
      infoHash: string,
      command: 'pause-torrent' | 'remove-torrent' | 'resume-torrent'
    ) => {
      setPending(infoHash)
      const outcome =
        command === 'remove-torrent'
          ? await runCommand({
              command,
              payload: { deleteData: false, infoHash }
            })
          : await runCommand({ command, payload: { infoHash } })
      if (!mounted.current) return
      setPending(null)
      if (!outcome.ok) {
        setFailure(outcome.error)
        return
      }
      await refresh()
    },
    [refresh]
  )

  return (
    <div className="torrent-list">
      {failure ? (
        <div className="torrent-placeholder">{failure.displayMessage}</div>
      ) : null}

      {torrents.map(torrent => {
        const isSelected = selected === torrent.infoHash
        const isActive =
          torrent.state === 'downloading' || torrent.state === 'seeding'
        const eta = calculateEta(
          torrent.length - torrent.downloaded,
          torrent.downloadSpeed
        )
        let speeds = ''
        if (torrent.downloadSpeed > 0) {
          speeds += ` ↓ ${prettyBytes(torrent.downloadSpeed)}/s`
        }
        if (torrent.uploadSpeed > 0) {
          speeds += ` ↑ ${prettyBytes(torrent.uploadSpeed)}/s`
        }

        return (
          <div
            className={`torrent${isSelected ? ' selected' : ''}`}
            key={torrent.infoHash}
            onClick={() => void select(torrent.infoHash)}
          >
            <div className="metadata">
              <div className="name ellipsis">{torrent.name}</div>
              <div className="ellipsis">
                <input
                  aria-label={`Download ${torrent.name}`}
                  checked={isActive}
                  className={`control download ${torrent.state}`}
                  disabled={pending === torrent.infoHash}
                  onChange={() =>
                    void act(
                      torrent.infoHash,
                      isActive ? 'pause-torrent' : 'resume-torrent'
                    )
                  }
                  onClick={event => event.stopPropagation()}
                  type="checkbox"
                />
                <span>{statusLabel(torrent)}</span>
                <progress max={1} value={torrent.progress} />
                <span>{`${Math.floor(100 * torrent.progress)}%`}</span>
                <span>
                  {torrent.downloaded === torrent.length
                    ? prettyBytes(torrent.length)
                    : `${prettyBytes(torrent.downloaded)} / ${prettyBytes(torrent.length)}`}
                </span>
                {torrent.peerCount > 0 ? (
                  <span>
                    {`${torrent.peerCount} ${torrent.peerCount === 1 ? 'peer' : 'peers'}`}
                  </span>
                ) : null}
                {speeds === '' ? null : <span>{speeds}</span>}
                {eta === '' ? null : <span>{eta}</span>}
              </div>
            </div>

            <div className="torrent-controls">
              <i
                aria-label={`Remove ${torrent.name}`}
                className="icon delete"
                onClick={event => {
                  event.stopPropagation()
                  void act(torrent.infoHash, 'remove-torrent')
                }}
                role="button"
                title="Remove torrent"
              >
                close
              </i>
            </div>

            {isSelected ? (
              <div className="torrent-details">
                <div className="files">
                  <table>
                    <tbody>
                      {files.map(file => {
                        const playable = PLAYABLE.test(file.path)
                        return (
                          <tr
                            className={file.selected ? '' : 'disabled'}
                            key={file.index}
                            onClick={event => {
                              event.stopPropagation()
                              if (!playable) return
                              onPlay({
                                fileIndex: file.index,
                                fileName: file.path,
                                infoHash: torrent.infoHash,
                                playlist: files
                                  .filter(entry => PLAYABLE.test(entry.path))
                                  .map(entry => ({
                                    fileIndex: entry.index,
                                    fileName: entry.path
                                  }))
                              })
                            }}
                          >
                            <td className="col-icon">
                              <i className="icon">
                                {playable ? 'play_arrow' : 'description'}
                              </i>
                            </td>
                            <td className="col-name">{file.path}</td>
                            <td className="col-progress">
                              {`${Math.floor(100 * file.progress)}%`}
                            </td>
                            <td className="col-size">
                              {prettyBytes(file.length)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <hr />
          </div>
        )
      })}

      <div className="torrent-placeholder">
        <span className="ellipsis">
          Drop a torrent file here or paste a magnet link
        </span>
      </div>
    </div>
  )
}
