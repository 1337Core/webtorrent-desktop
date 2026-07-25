import { useCallback, useEffect, useState } from 'react'
import {
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

type Preparation = EngineValue<'open-preparation'>
type PreparationFile = EngineValue<'get-preparation-files'>['items'][number]

const FILE_PAGE_LIMIT = 64

const WARNING_LABELS: Readonly<Record<string, string>> = {
  DHT_EXPOSURE_USED: 'The info hash was exposed to the public DHT.',
  TRACKER_TRANSPORT_DISABLED: 'Some trackers use an unsupported transport.',
  WEB_SEED_DISABLED: 'Web seeds are disabled in this release.',
  WEB_SEED_INVALID: 'Some web seeds were rejected.',
  XS_REMOVED: 'An exact-source parameter was removed.'
}

export type AddTorrentProps = Readonly<{
  /** Absent until main has resolved the download root. */
  downloadRoot: string | null
  /** A validated open request from Finder or a magnet link. */
  intent?: Readonly<
    | { kind: 'magnet'; magnet: string }
    | { kind: 'torrent-file'; torrentPath: string }
  > | null
  onAdded: () => void
  ready: boolean
}>

/**
 * The two-phase add. A remote `.torrent` is prepared first so its name, size,
 * and warnings can be reviewed, and only an explicit confirmation commits it
 * to disk. Nothing is written before that.
 */
export function AddTorrent({
  downloadRoot,
  intent = null,
  onAdded,
  ready
}: AddTorrentProps): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [preparation, setPreparation] = useState<Preparation | null>(null)
  const [files, setFiles] = useState<ReadonlyArray<PreparationFile>>([])
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())

  const prepare = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    const outcome = await runCommand({
      command: 'open-preparation',
      payload: {
        source: {
          allowHttp: false,
          allowPrivateNetwork: false,
          kind: 'remote-torrent',
          url: url.trim()
        }
      }
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setPreparation(outcome.value)
  }, [url])

  // An OS open request prepares exactly like a typed URL: reviewed first,
  // committed only on confirmation.
  useEffect(() => {
    if (!intent || !ready) return undefined
    const timer = setTimeout(() => {
      void runCommand({
        command: 'open-preparation',
        payload: {
          source:
            intent.kind === 'magnet'
              ? {
                  allowDhtExposure: false,
                  allowPrivateNetwork: false,
                  kind: 'magnet',
                  magnet: intent.magnet
                }
              : { kind: 'local-torrent', path: intent.torrentPath }
        }
      }).then(outcome => {
        if (!outcome.ok) {
          setFailure(outcome.error)
          return
        }
        setPreparation(outcome.value)
      })
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [intent, ready])

  // The first page of the manifest is enough to review a typical torrent;
  // larger torrents keep their remaining files deselected until committed.
  useEffect(() => {
    if (!preparation) return undefined

    let active = true
    const timer = setTimeout(() => {
      void runCommand({
        command: 'get-preparation-files',
        payload: {
          cursor: 0,
          limit: FILE_PAGE_LIMIT,
          preparationId: preparation.preparationId
        }
      }).then(outcome => {
        if (!active || !outcome.ok) return
        setFiles(outcome.value.items)
        setSelected(
          new Set(
            outcome.value.items
              .filter(file => file.selected)
              .map(file => file.index)
          )
        )
      })
    }, 0)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [preparation])

  const toggleFile = useCallback(
    async (file: PreparationFile) => {
      if (!preparation) return
      const next = !selected.has(file.index)
      const outcome = await runCommand({
        command: 'update-preparation-selection',
        payload: {
          changes: [{ index: file.index, selected: next }],
          preparationId: preparation.preparationId
        }
      })
      if (!outcome.ok) {
        setFailure(outcome.error)
        return
      }
      setSelected(current => {
        const updated = new Set(current)
        if (next) updated.add(file.index)
        else updated.delete(file.index)
        return updated
      })
    },
    [preparation, selected]
  )

  const discard = useCallback(async () => {
    if (!preparation) return
    setBusy(true)
    await runCommand({
      command: 'discard-preparation',
      payload: { preparationId: preparation.preparationId }
    })
    setBusy(false)
    setPreparation(null)
    setFiles([])
    setSelected(new Set())
  }, [preparation])

  const commit = useCallback(async () => {
    if (!preparation || downloadRoot === null) return
    setBusy(true)
    setFailure(null)
    const outcome = await runCommand({
      command: 'commit-preparation',
      payload: {
        destinationRoot: downloadRoot,
        preparationId: preparation.preparationId
      }
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setPreparation(null)
    setFiles([])
    setSelected(new Set())
    setUrl('')
    onAdded()
  }, [downloadRoot, onAdded, preparation])

  return (
    <section aria-labelledby="add-torrent-heading">
      <h2 id="add-torrent-heading">Add a torrent</h2>

      {preparation ? (
        <div className="preparation">
          <p className="torrent-name">{preparation.name}</p>
          <p className="torrent-meta">
            {`${preparation.fileCount} files · ${preparation.length} bytes${
              preparation.private ? ' · private' : ''
            }`}
          </p>
          {preparation.warnings.length > 0 ? (
            <ul className="warnings">
              {preparation.warnings.map(warning => (
                <li key={warning}>{WARNING_LABELS[warning] ?? warning}</li>
              ))}
            </ul>
          ) : null}
          {files.length > 0 ? (
            <ul className="file-list">
              {files.map(file => (
                <li key={file.index}>
                  <label>
                    <input
                      checked={selected.has(file.index)}
                      onChange={() => void toggleFile(file)}
                      type="checkbox"
                    />
                    {` ${file.path} (${file.length} bytes)`}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="torrent-meta">
            {downloadRoot === null
              ? 'No download folder is available yet.'
              : `Saving to ${downloadRoot}`}
          </p>
          <div className="torrent-actions">
            <button
              disabled={busy || downloadRoot === null}
              onClick={() => void commit()}
              type="button"
            >
              Start download
            </button>
            <button
              disabled={busy}
              onClick={() => void discard()}
              type="button"
            >
              Discard
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={event => {
            event.preventDefault()
            void prepare()
          }}
        >
          <label htmlFor="torrent-url">Torrent file URL</label>
          <input
            id="torrent-url"
            name="torrent-url"
            onChange={event => setUrl(event.target.value)}
            placeholder="https://example.com/file.torrent"
            type="url"
            value={url}
          />
          <button disabled={busy || !ready || url.trim() === ''} type="submit">
            Prepare
          </button>
        </form>
      )}

      {failure ? (
        <p className="error" role="alert">
          {failure.displayMessage}
        </p>
      ) : null}
    </section>
  )
}
