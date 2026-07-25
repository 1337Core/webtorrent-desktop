import { useCallback, useEffect, useRef, useState } from 'react'
import { prettyBytes } from '../lib/format'
import {
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

type Preparation = EngineValue<'open-preparation'>
type PreparationFile = EngineValue<'get-preparation-files'>['items'][number]

const FILE_PAGE_LIMIT = 64
const MAGNET = /^magnet:\?/iu
/** How often the pending acquisition is checked, and how long it may run. */
const ACQUISITION_POLL_MS = 500
const ACQUISITION_DEADLINE_MS = 130_000

const ACQUISITION_FAILURES: Readonly<Record<string, string>> = {
  INPUT_INVALID: 'That magnet link could not be read.',
  INTERNAL: 'The torrent details could not be fetched.',
  METADATA_UNAVAILABLE:
    'No peer answered with this torrent’s details. Try again later.'
}

type PreparationSource = Extract<
  Parameters<typeof runCommand>[0],
  { command: 'start-acquisition' }
>['payload']['source']

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
  const [acquiring, setAcquiring] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  /**
   * A magnet carries no manifest, so its metadata is fetched before there is
   * anything to review. The engine cannot answer that inside one bounded
   * command, so the acquisition is started and then polled until it settles.
   */
  const acquire = useCallback(
    async (
      source: Extract<PreparationSource, { kind: 'magnet' }>
    ): Promise<void> => {
      setAcquiring(true)
      setFailure(null)
      const started = await runCommand({
        command: 'start-acquisition',
        payload: { source }
      })
      if (!started.ok) {
        setAcquiring(false)
        setFailure(started.error)
        return
      }

      const deadline = Date.now() + ACQUISITION_DEADLINE_MS
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, ACQUISITION_POLL_MS))
        if (cancelled.current) return
        const polled = await runCommand({
          command: 'get-acquisition',
          payload: { acquisitionId: started.value.acquisitionId }
        })
        if (!polled.ok) {
          setAcquiring(false)
          setFailure(polled.error)
          return
        }
        if (polled.value.state === 'ready') {
          setAcquiring(false)
          setPreparation(polled.value.preparation)
          return
        }
        if (polled.value.state === 'failed') {
          setAcquiring(false)
          setFailure({
            code: polled.value.code,
            displayMessage:
              ACQUISITION_FAILURES[polled.value.code] ??
              'The torrent details could not be fetched.',
            retryable: polled.value.code === 'METADATA_UNAVAILABLE'
          })
          return
        }
      }
      if (!cancelled.current) {
        setAcquiring(false)
        setFailure({
          code: 'METADATA_UNAVAILABLE',
          displayMessage:
            ACQUISITION_FAILURES.METADATA_UNAVAILABLE ??
            'The torrent details could not be fetched.',
          retryable: true
        })
      }
    },
    []
  )

  const prepare = useCallback(async () => {
    const address = url.trim()
    if (MAGNET.test(address)) {
      await acquire({
        allowDhtExposure: false,
        allowPrivateNetwork: false,
        kind: 'magnet',
        magnet: address
      })
      return
    }
    setBusy(true)
    setFailure(null)
    const outcome = await runCommand({
      command: 'open-preparation',
      payload: {
        source: {
          allowHttp: false,
          allowPrivateNetwork: false,
          kind: 'remote-torrent',
          url: address
        }
      }
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setPreparation(outcome.value)
  }, [acquire, url])

  // An OS open request prepares exactly like a typed URL: reviewed first,
  // committed only on confirmation.
  useEffect(() => {
    if (!intent || !ready) return undefined
    const timer = setTimeout(() => {
      if (intent.kind === 'magnet') {
        void acquire({
          allowDhtExposure: false,
          allowPrivateNetwork: false,
          kind: 'magnet',
          magnet: intent.magnet
        })
        return
      }
      void runCommand({
        command: 'open-preparation',
        payload: {
          source: { kind: 'local-torrent', path: intent.torrentPath }
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
  }, [acquire, intent, ready])

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
      ) : acquiring ? (
        <div className="torrent-info" role="status">
          Fetching torrent details…
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
