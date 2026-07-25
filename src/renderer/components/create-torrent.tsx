import { useCallback, useState } from 'react'
import { runCommand, type EngineFailure } from '../lib/engine-client'

export type CreateTorrentProps = Readonly<{
  onCreated: () => void
  ready: boolean
}>

function operationId(): string {
  return crypto.randomUUID()
}

/**
 * Creates a torrent from a file or folder the user picks in a main-owned
 * chooser. The renderer never enumerates the filesystem and never proposes a
 * path of its own; the engine revalidates whatever comes back.
 */
export function CreateTorrent({
  onCreated,
  ready
}: CreateTorrentProps): React.JSX.Element {
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [tracker, setTracker] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<EngineFailure | null>(null)
  const [created, setCreated] = useState<string | null>(null)

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
    if (result.value.path !== null) setSourcePath(result.value.path)
  }, [])

  const create = useCallback(async () => {
    if (sourcePath === null) return
    const endpoint = tracker.trim()
    setBusy(true)
    setFailure(null)
    setCreated(null)

    const outcome = await runCommand({
      command: 'create-torrent',
      payload: {
        allowHttpTrackers: false,
        allowPrivateNetwork: false,
        announceTiers: endpoint === '' ? [] : [[endpoint]],
        destinationRoot: sourcePath,
        filterJunkFiles: true,
        operationId: operationId(),
        private: isPrivate,
        sourcePath
      }
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.error)
      return
    }
    setCreated(outcome.value.torrent.name)
    setSourcePath(null)
    setTracker('')
    setIsPrivate(false)
    onCreated()
  }, [isPrivate, onCreated, sourcePath, tracker])

  return (
    <section aria-labelledby="create-torrent-heading">
      <h2 id="create-torrent-heading">Create a torrent</h2>

      <div className="torrent-actions">
        <button
          disabled={busy}
          onClick={() => void chooseSource()}
          type="button"
        >
          Choose file or folder
        </button>
        <span className="torrent-meta">
          {sourcePath ?? 'Nothing selected yet.'}
        </span>
      </div>

      <label htmlFor="create-tracker">Tracker (optional)</label>
      <input
        id="create-tracker"
        name="create-tracker"
        onChange={event => setTracker(event.target.value)}
        placeholder="https://tracker.example/announce"
        type="url"
        value={tracker}
      />

      <label htmlFor="create-private">
        <input
          checked={isPrivate}
          id="create-private"
          onChange={event => setIsPrivate(event.target.checked)}
          type="checkbox"
        />
        {' Private torrent'}
      </label>

      <button
        disabled={
          busy ||
          !ready ||
          sourcePath === null ||
          (isPrivate && tracker.trim() === '')
        }
        onClick={() => void create()}
        type="button"
      >
        Create and seed
      </button>

      {created ? <p className="summary">{`Seeding ${created}.`}</p> : null}
      {failure ? (
        <p className="error" role="alert">
          {failure.displayMessage}
        </p>
      ) : null}
    </section>
  )
}
