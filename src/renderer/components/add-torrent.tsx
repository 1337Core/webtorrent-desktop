import { useCallback, useEffect, useRef, useState } from 'react'
import { prettyBytes } from '../lib/format'
import {
  collectFilePages,
  runCommand,
  type EngineFailure,
  type EngineValue
} from '../lib/engine-client'

type Preparation = EngineValue<'open-preparation'>
type PreparationFile = EngineValue<'get-preparation-files'>['items'][number]

const FILE_PAGE_LIMIT = 64
const MAGNET = /^magnet:\?/iu
const INFO_HASH = /^[a-f\d]{40}$/iu
/** How often the pending acquisition is checked, and how long it may run. */
const ACQUISITION_POLL_MS = 500
const ACQUISITION_DEADLINE_MS = 130_000

const ACQUISITION_FAILURES: Readonly<Record<string, string>> = {
  DHT_CONSENT_REQUIRED:
    'This torrent has no usable tracker. Public DHT lookup was not allowed.',
  INPUT_INVALID: 'That magnet link could not be read.',
  INTERNAL: 'The torrent details could not be fetched.',
  METADATA_UNAVAILABLE:
    'No peer answered with this torrent’s details. Try again later.',
  PRIVATE_DHT_METADATA:
    'The recovered torrent is private. Use a tracker-bearing magnet or torrent file instead.'
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
  /**
   * The pending DHT exposure question. `disableDialogs` is on for this window,
   * so `window.confirm` can never present it; the modal asks in its own markup
   * and this resolver carries the answer back to the waiting acquisition.
   */
  const [dhtConsent, setDhtConsent] = useState<{
    resolve: (granted: boolean) => void
  } | null>(null)
  const cancelled = useRef(false)
  const dhtConsentRef = useRef<((granted: boolean) => void) | null>(null)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
      // An unmount answers the outstanding question rather than leaving the
      // acquisition awaiting a promise nothing will ever settle.
      dhtConsentRef.current?.(false)
      dhtConsentRef.current = null
    }
  }, [])

  const askDhtConsent = useCallback(
    () =>
      new Promise<boolean>(resolve => {
        const settle = (granted: boolean): void => {
          dhtConsentRef.current = null
          setDhtConsent(null)
          resolve(granted)
        }
        dhtConsentRef.current = settle
        setDhtConsent({ resolve: settle })
      }),
    []
  )

  /**
   * A magnet carries no manifest, so its metadata is fetched before there is
   * anything to review. The engine cannot answer that inside one bounded
   * command, so the acquisition is started and then polled until it settles.
   */
  const acquire = useCallback(
    async (initialSource: PreparationSource): Promise<void> => {
      setAcquiring(true)
      setFailure(null)
      let source = initialSource
      // Polling continues even after the modal closes. A settled acquisition
      // is reported once and forgotten by the engine, so consuming the result
      // releases its slot immediately instead of leaving it to expire, and any
      // preparation it produced is discarded rather than stranded.
      for (;;) {
        const started = await runCommand({
          command: 'start-acquisition',
          payload: { source }
        })
        if (!started.ok) {
          if (cancelled.current) return
          setAcquiring(false)
          setFailure(started.error)
          return
        }

        const deadline = Date.now() + ACQUISITION_DEADLINE_MS
        let retryWithDht = false
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, ACQUISITION_POLL_MS))
          const polled = await runCommand({
            command: 'get-acquisition',
            payload: { acquisitionId: started.value.acquisitionId }
          })
          if (!polled.ok) {
            if (cancelled.current) return
            setAcquiring(false)
            setFailure(polled.error)
            return
          }
          if (polled.value.state === 'ready') {
            if (cancelled.current) {
              await runCommand({
                command: 'discard-preparation',
                payload: {
                  preparationId: polled.value.preparation.preparationId
                }
              })
              return
            }
            setAcquiring(false)
            setPreparation(polled.value.preparation)
            return
          }
          if (polled.value.state !== 'failed') continue
          if (cancelled.current) return
          if (
            polled.value.code === 'DHT_CONSENT_REQUIRED' &&
            !source.allowDhtExposure &&
            (await askDhtConsent())
          ) {
            if (cancelled.current) return
            source = { ...source, allowDhtExposure: true }
            retryWithDht = true
            break
          }
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
        if (retryWithDht) continue
        if (cancelled.current) return
        setAcquiring(false)
        setFailure({
          code: 'METADATA_UNAVAILABLE',
          displayMessage:
            ACQUISITION_FAILURES.METADATA_UNAVAILABLE ??
            'The torrent details could not be fetched.',
          retryable: true
        })
        return
      }
    },
    [askDhtConsent]
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
    if (INFO_HASH.test(address)) {
      await acquire({
        allowDhtExposure: false,
        allowPrivateNetwork: false,
        infoHash: address.toLowerCase(),
        kind: 'info-hash'
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
      // The whole manifest, not one page: a file past the first page would
      // otherwise be impossible to review or select before committing.
      void collectFilePages(cursor =>
        runCommand({
          command: 'get-preparation-files',
          payload: {
            cursor,
            limit: FILE_PAGE_LIMIT,
            preparationId: preparation.preparationId
          }
        })
      ).then(outcome => {
        if (!active || !outcome.ok) return
        setFiles(outcome.items)
        setSelected(
          new Set(
            outcome.items.filter(file => file.selected).map(file => file.index)
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
      ) : dhtConsent ? (
        <div className="dht-consent" role="group">
          <p>
            <label>
              This torrent has no usable tracker. Look up its info hash on the
              public DHT?
            </label>
          </p>
          <div className="torrent-info">
            This exposes the info hash to public DHT nodes.
          </div>
          <div className="float-right">
            <button
              className="control cancel"
              onClick={() => dhtConsent.resolve(false)}
              type="button"
            >
              NO
            </button>
            <button
              className="control"
              onClick={() => dhtConsent.resolve(true)}
              type="button"
            >
              LOOK UP
            </button>
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
