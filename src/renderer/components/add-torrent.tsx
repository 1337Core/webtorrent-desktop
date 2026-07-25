import { useCallback, useEffect, useState } from 'react'
import { prettyBytes } from '../lib/format'
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

export type AddTorrentModalProps = Readonly<{
  /** Absent until main has resolved the download root. */
  downloadRoot: string | null
  /** A validated open request from Finder or a magnet link. */
  intent?: Readonly<
    | { kind: 'magnet'; magnet: string }
    | { kind: 'torrent-file'; torrentPath: string }
  > | null
  onAdded: () => void
  onCancel: () => void
  ready: boolean
}>

/**
 * The original "open torrent address" modal. Its shape is unchanged — a label,
 * one address field, and the CANCEL/OK pair — but OK now runs the two-phase
 * add from section 9.8: the manifest is prepared and shown in the same modal,
 * and only the second OK commits it to disk.
 */
export function AddTorrentModal({
  downloadRoot,
  intent = null,
  onAdded,
  onCancel,
  ready
}: AddTorrentModalProps): React.JSX.Element {
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

  // CANCEL always leaves the engine clean: an open preparation is discarded
  // rather than left holding its reservation.
  const cancel = useCallback(async () => {
    if (preparation) {
      setBusy(true)
      await runCommand({
        command: 'discard-preparation',
        payload: { preparationId: preparation.preparationId }
      })
      setBusy(false)
      setPreparation(null)
      setFiles([])
      setSelected(new Set())
    }
    onCancel()
  }, [onCancel, preparation])

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
    <form
      className="open-torrent-address-modal"
      onSubmit={event => {
        event.preventDefault()
        if (preparation) void commit()
        else void prepare()
      }}
    >
      {preparation ? (
        <div className="preparation">
          <p>
            <label>{preparation.name}</label>
          </p>
          <div className="torrent-info">
            {`${preparation.fileCount} files, ${prettyBytes(preparation.length)}${
              preparation.private ? ', private' : ''
            }`}
          </div>
          {preparation.warnings.map(warning => (
            <div className="torrent-info" key={warning}>
              {WARNING_LABELS[warning] ?? warning}
            </div>
          ))}
          {files.length > 0 ? (
            <div className="file-list">
              {files.map(file => (
                <div key={file.index}>
                  <label className="control checkbox">
                    <input
                      checked={selected.has(file.index)}
                      onChange={() => void toggleFile(file)}
                      type="checkbox"
                    />
                    <span>{`${file.path} (${prettyBytes(file.length)})`}</span>
                  </label>
                </div>
              ))}
            </div>
          ) : null}
          <div className="torrent-info">
            {downloadRoot === null
              ? 'No download folder is available yet.'
              : `Saving to ${downloadRoot}`}
          </div>
        </div>
      ) : (
        <>
          <p>
            <label htmlFor="torrent-address-field">
              Enter torrent address or magnet link
            </label>
          </p>
          <div>
            <input
              autoFocus
              className="control"
              id="torrent-address-field"
              name="torrent-address-field"
              onChange={event => setUrl(event.target.value)}
              type="text"
              value={url}
            />
          </div>
        </>
      )}

      {failure ? (
        <div className="error" role="alert">
          {failure.displayMessage}
        </div>
      ) : null}

      <div className="float-right">
        <button
          className="control cancel"
          disabled={busy}
          onClick={() => void cancel()}
          type="button"
        >
          CANCEL
        </button>
        <button
          className="control ok"
          disabled={
            busy ||
            (preparation ? downloadRoot === null : !ready || url.trim() === '')
          }
          type="submit"
        >
          OK
        </button>
      </div>
    </form>
  )
}
