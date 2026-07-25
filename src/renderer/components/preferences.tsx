import { useCallback, useState } from 'react'

type PreferenceValues = Readonly<{
  downloadRoot: string | null
  externalPlayer: string | null
  torrentsFolder: string | null
}>

export type PreferencesProps = Readonly<{
  onChanged: (preferences: PreferenceValues) => void
  preferences: PreferenceValues
}>

/**
 * The only preference the first release exposes. The folder always comes from
 * the main-owned chooser and main validates it before persisting, so the
 * renderer never stores a path of its own.
 */
export function Preferences({
  onChanged,
  preferences
}: PreferencesProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const save = useCallback(
    async (
      update: Readonly<{
        downloadRoot?: string
        externalPlayer?: string | null
        torrentsFolder?: string | null
      }>
    ) => {
      const saved = await window.desktop.setPreferences(update)
      setBusy(false)
      if (!saved.ok) {
        setFailure(saved.error.displayMessage)
        return
      }
      onChanged(saved.value.preferences)
    },
    [onChanged]
  )

  const choose = useCallback(
    async (
      kind: 'application' | 'directory' | 'source' | 'torrent-file',
      apply: (chosenPath: string) => Parameters<typeof save>[0]
    ) => {
      setBusy(true)
      setFailure(null)
      const chosen = await window.desktop.choosePath(kind)
      if (!chosen.ok) {
        setBusy(false)
        setFailure(chosen.error.displayMessage)
        return
      }
      if (chosen.value.path === null) {
        setBusy(false)
        return
      }
      await save(apply(chosen.value.path))
    },
    [save]
  )

  const clear = useCallback(
    async (update: Parameters<typeof save>[0]) => {
      setBusy(true)
      setFailure(null)
      await save(update)
    },
    [save]
  )

  return (
    <section aria-labelledby="preferences-heading">
      <h2 id="preferences-heading">Preferences</h2>
      <div className="torrent-actions">
        <button
          disabled={busy}
          onClick={() =>
            void choose('directory', downloadRoot => ({ downloadRoot }))
          }
          type="button"
        >
          Change download folder
        </button>
        <span className="torrent-meta">
          {preferences.downloadRoot ?? 'No download folder yet.'}
        </span>
      </div>

      <div className="torrent-actions">
        <button
          disabled={busy}
          onClick={() =>
            void choose('directory', torrentsFolder => ({ torrentsFolder }))
          }
          type="button"
        >
          Watch a folder for torrents
        </button>
        <span className="torrent-meta">
          {preferences.torrentsFolder ?? 'No folder is watched.'}
        </span>
        {preferences.torrentsFolder === null ? null : (
          <button
            disabled={busy}
            onClick={() => void clear({ torrentsFolder: null })}
            type="button"
          >
            Stop watching
          </button>
        )}
      </div>

      <div className="torrent-actions">
        <button
          disabled={busy}
          onClick={() =>
            void choose('application', externalPlayer => ({ externalPlayer }))
          }
          type="button"
        >
          Choose an external player
        </button>
        <span className="torrent-meta">
          {preferences.externalPlayer ?? 'No external player is configured.'}
        </span>
        {preferences.externalPlayer === null ? null : (
          <button
            disabled={busy}
            onClick={() => void clear({ externalPlayer: null })}
            type="button"
          >
            Clear player
          </button>
        )}
      </div>
      {failure ? (
        <p className="error" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  )
}
