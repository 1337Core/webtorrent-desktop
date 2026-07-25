import { useCallback, useState } from 'react'

export type PreferencesProps = Readonly<{
  downloadRoot: string | null
  onChanged: (downloadRoot: string) => void
}>

/**
 * The only preference the first release exposes. The folder always comes from
 * the main-owned chooser and main validates it before persisting, so the
 * renderer never stores a path of its own.
 */
export function Preferences({
  downloadRoot,
  onChanged
}: PreferencesProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const choose = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    const chosen = await window.desktop.choosePath('directory')
    if (!chosen.ok) {
      setBusy(false)
      setFailure(chosen.error.displayMessage)
      return
    }
    if (chosen.value.path === null) {
      setBusy(false)
      return
    }

    const saved = await window.desktop.setDownloadRoot(chosen.value.path)
    setBusy(false)
    if (!saved.ok) {
      setFailure(saved.error.displayMessage)
      return
    }
    if (saved.value.preferences.downloadRoot !== null) {
      onChanged(saved.value.preferences.downloadRoot)
    }
  }, [onChanged])

  return (
    <section aria-labelledby="preferences-heading">
      <h2 id="preferences-heading">Preferences</h2>
      <div className="torrent-actions">
        <button disabled={busy} onClick={() => void choose()} type="button">
          Change download folder
        </button>
        <span className="torrent-meta">
          {downloadRoot ?? 'No download folder yet.'}
        </span>
      </div>
      {failure ? (
        <p className="error" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  )
}
