import { useCallback, useState } from 'react'
import { prettyBytes } from '../lib/format'
import { runCommand, type EngineFailure } from '../lib/engine-client'

type Source = Readonly<{
  fileCount: number | null
  path: string
  totalBytes: number | null
}>

type CreatedTorrent = Readonly<{
  infoHash: string
  name: string
}>

export type CreateTorrentPageProps = Readonly<{
  onCancel: () => void
  onCreated: () => void
  ready: boolean
}>

function operationId(): string {
  return crypto.randomUUID()
}

function basename(value: string): string {
  const parts = value.split('/').filter(part => part !== '')
  return parts.at(-1) ?? value
}

/**
 * The original create-torrent screen: the chosen name as the heading, the file
 * count and size beneath it, the path attribute, the advanced settings behind
 * "Show advanced settings...", and the Cancel / Create Torrent pair. The source
 * still comes from the main-owned chooser, so the renderer never enumerates
 * the filesystem and never proposes a path of its own.
 */
export function CreateTorrentPage({
  onCancel,
  onCreated,
  ready
}: CreateTorrentPageProps): React.JSX.Element {
  const [source, setSource] = useState<Source | null>(null)
  const [trackers, setTrackers] = useState('')
  const [comment, setComment] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [created, setCreated] = useState<CreatedTorrent | null>(null)

  const chooseSource = useCallback(async () => {
    const result = await window.desktop.choosePath('source')
    if (!result.ok) {
      setFailure({
        code: result.error.code,
        displayMessage: result.error.displayMessage,
        retryable: result.error.retryable
      })
      return
    }
    if (result.value.path === null) return
    setSource({
      fileCount: result.value.summary?.fileCount ?? null,
      path: result.value.path,
      totalBytes: result.value.summary?.totalBytes ?? null
    })
  }, [])

  const create = useCallback(async () => {
    if (source === null) return
    const announceTiers = trackers
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => [line])
    const description = comment.trim()
    setBusy(true)
    setFailure(null)
    setCreated(null)

    const outcome = await runCommand({
      command: 'create-torrent',
      payload: {
        allowHttpTrackers: false,
        allowPrivateNetwork: false,
        announceTiers,
        destinationRoot: source.path,
        filterJunkFiles: true,
        operationId: operationId(),
        private: isPrivate,
        sourcePath: source.path,
        ...(description === '' ? {} : { comment: description })
      }
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    const completed = {
      infoHash: outcome.value.torrent.infoHash,
      name: outcome.value.torrent.name
    }
    setCreated(completed)
    setSource(null)
    setTrackers('')
    setComment('')
    setIsPrivate(false)
    setBusy(true)
    const exported = await window.desktop.exportTorrent(completed.infoHash)
    setBusy(false)
    if (!exported.ok) {
      setFailure({
        code: exported.error.code,
        displayMessage: exported.error.displayMessage,
        retryable: exported.error.retryable
      })
      return
    }
    if (!exported.value.saved) return
    onCreated()
  }, [comment, isPrivate, onCreated, source, trackers])

  const retryExport = useCallback(async () => {
    if (created === null) return
    setBusy(true)
    setFailure(null)
    const exported = await window.desktop.exportTorrent(created.infoHash)
    setBusy(false)
    if (!exported.ok) {
      setFailure({
        code: exported.error.code,
        displayMessage: exported.error.displayMessage,
        retryable: exported.error.retryable
      })
      return
    }
    if (!exported.value.saved) return
    onCreated()
  }, [created, onCreated])

  const torrentInfo =
    source === null
      ? null
      : source.fileCount === null || source.totalBytes === null
        ? source.path
        : `${source.fileCount} files, ${prettyBytes(source.totalBytes)}`

  return (
    <div className="create-torrent">
      <h1>
        {source === null
          ? 'Create torrent'
          : `Create torrent ${basename(source.path)}`}
      </h1>

      {source === null ? (
        <p className="torrent-info">
          Select the file or folder to share. Hidden files, starting with a .
          character, are not included.
        </p>
      ) : (
        <div className="torrent-info">{torrentInfo}</div>
      )}

      <div className="torrent-attribute">
        <label>Path:</label>
        <div>
          {source === null ? (
            <button
              className="control"
              disabled={busy}
              onClick={() => void chooseSource()}
              type="button"
            >
              Choose file or folder
            </button>
          ) : (
            source.path
          )}
        </div>
      </div>

      <div className="show-more">
        {expanded ? (
          <div className="create-torrent-advanced">
            <div className="torrent-attribute">
              <label htmlFor="torrent-is-private">Private:</label>
              <div>
                <input
                  checked={isPrivate}
                  className="torrent-is-private control"
                  id="torrent-is-private"
                  onChange={event => setIsPrivate(event.target.checked)}
                  type="checkbox"
                />
              </div>
            </div>
            <div className="torrent-attribute">
              <label htmlFor="torrent-trackers">Trackers:</label>
              <div>
                <textarea
                  className="torrent-trackers control"
                  id="torrent-trackers"
                  onChange={event => setTrackers(event.target.value)}
                  rows={2}
                  value={trackers}
                />
              </div>
            </div>
            <div className="torrent-attribute">
              <label htmlFor="torrent-comment">Comment:</label>
              <div>
                <textarea
                  className="torrent-comment control"
                  id="torrent-comment"
                  onChange={event => setComment(event.target.value)}
                  placeholder="Optionally describe your torrent..."
                  rows={2}
                  value={comment}
                />
              </div>
            </div>
          </div>
        ) : null}
        <button
          className="control"
          onClick={() => setExpanded(current => !current)}
          type="button"
        >
          {expanded ? 'Hide advanced settings...' : 'Show advanced settings...'}
        </button>
      </div>

      {created ? (
        <div className="torrent-info">{`Seeding ${created.name}.`}</div>
      ) : null}
      {failure ? (
        <div className="error" role="alert">
          {failure.displayMessage}
        </div>
      ) : null}

      <div className="float-right">
        <button
          className="control cancel"
          disabled={busy}
          onClick={created === null ? onCancel : onCreated}
          type="button"
        >
          {created === null ? 'Cancel' : 'Done'}
        </button>
        <button
          className="control create-torrent-button"
          disabled={
            busy ||
            !ready ||
            (created === null &&
              (source === null || (isPrivate && trackers.trim() === '')))
          }
          onClick={() => void (created === null ? create() : retryExport())}
          type="button"
        >
          {created === null ? 'Create Torrent' : 'Save Torrent File...'}
        </button>
      </div>
    </div>
  )
}
