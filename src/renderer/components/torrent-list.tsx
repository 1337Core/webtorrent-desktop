import { useCallback, useEffect, useRef, useState } from 'react'
import {
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

const TORRENT_LIST_REFRESH_MS = 1_000
const PAGE_LIMIT = 64

type TorrentSummary = EngineValue<'list-torrents'>['items'][number]

const STATE_LABELS: Readonly<Record<TorrentSummary['state'], string>> = {
  checking: 'Checking',
  downloading: 'Downloading',
  error: 'Error',
  paused: 'Paused',
  seeding: 'Seeding',
  stopped: 'Stopped'
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let scaled = value / 1_000
  let unit = 0
  while (scaled >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000
    unit += 1
  }
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[unit]}`
}

function formatRate(value: number): string {
  return value > 0 ? `${formatBytes(value)}/s` : '—'
}

export type TorrentListProps = Readonly<{
  /** Disabled while the engine is not ready; the list stops polling. */
  active: boolean
  refreshMs?: number
}>

/**
 * The torrent list. It owns no torrent state of its own: every row comes from
 * the engine's bounded page, and each action re-reads the page rather than
 * guessing what the engine did.
 */
export function TorrentList({
  active,
  refreshMs = TORRENT_LIST_REFRESH_MS
}: TorrentListProps): React.JSX.Element {
  const [torrents, setTorrents] = useState<ReadonlyArray<TorrentSummary>>([])
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [pending, setPending] = useState<string | null>(null)
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
    // Deferred so the first read happens after the effect, not during it.
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), refreshMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active, refresh, refreshMs])

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

  if (torrents.length === 0) {
    return (
      <section aria-labelledby="torrents-heading">
        <h2 id="torrents-heading">Torrents</h2>
        {failure ? (
          <p className="error" role="alert">
            {failure.displayMessage}
          </p>
        ) : (
          <p className="summary">No torrents yet.</p>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby="torrents-heading">
      <h2 id="torrents-heading">Torrents</h2>
      {failure ? (
        <p className="error" role="alert">
          {failure.displayMessage}
        </p>
      ) : null}
      <ul className="torrent-list">
        {torrents.map(torrent => (
          <li key={torrent.infoHash} className="torrent-row">
            <div>
              <p className="torrent-name">{torrent.name}</p>
              <p className="torrent-meta">
                <span>{STATE_LABELS[torrent.state]}</span>
                <span>{` · ${Math.round(torrent.progress * 100)}%`}</span>
                <span>{` · ${formatBytes(torrent.length)}`}</span>
                <span>{` · ↓ ${formatRate(torrent.downloadSpeed)}`}</span>
                <span>{` · ↑ ${formatRate(torrent.uploadSpeed)}`}</span>
                <span>{` · ${torrent.peerCount} peers`}</span>
              </p>
              <progress max={1} value={torrent.progress}>
                {Math.round(torrent.progress * 100)}%
              </progress>
            </div>
            <div className="torrent-actions">
              {torrent.state === 'paused' ? (
                <button
                  disabled={pending === torrent.infoHash}
                  onClick={() => void act(torrent.infoHash, 'resume-torrent')}
                  type="button"
                >
                  {`Resume ${torrent.name}`}
                </button>
              ) : (
                <button
                  disabled={pending === torrent.infoHash}
                  onClick={() => void act(torrent.infoHash, 'pause-torrent')}
                  type="button"
                >
                  {`Pause ${torrent.name}`}
                </button>
              )}
              <button
                disabled={pending === torrent.infoHash}
                onClick={() => void act(torrent.infoHash, 'remove-torrent')}
                type="button"
              >
                {`Remove ${torrent.name}`}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
