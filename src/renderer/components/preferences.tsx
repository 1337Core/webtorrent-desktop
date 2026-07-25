import { useCallback, useState } from 'react'

type PreferenceValues = Readonly<{
  downloadRoot: string | null
  externalPlayer: string | null
  torrentsFolder: string | null
}>

export type PreferencesPageProps = Readonly<{
  onChanged: (preferences: PreferenceValues) => void
  preferences: PreferenceValues
}>

type PathRowProps = Readonly<{
  busy: boolean
  onChange: () => void
  onClear?: () => void
  title: string
  value: string | null
}>

/**
 * The original path selector: a label, the current value in a disabled field,
 * and a Change button that opens the main-owned dialog.
 */
function PathSelector({
  busy,
  onChange,
  onClear,
  title,
  value
}: PathRowProps): React.JSX.Element {
  const id = title.replaceAll(' ', '-').toLowerCase()
  return (
    <div className="path-selector">
      <div className="label">
        <label htmlFor={id}>{`${title}:`}</label>
      </div>
      <input
        className="control"
        disabled
        id={id}
        readOnly
        value={value ?? ''}
      />
      <button
        aria-label={`Change ${title}`}
        className="control"
        disabled={busy}
        onClick={onChange}
        type="button"
      >
        Change
      </button>
      {onClear && value !== null ? (
        <button
          aria-label={`Clear ${title}`}
          className="control"
          disabled={busy}
          onClick={onClear}
          type="button"
        >
          Clear
        </button>
      ) : null}
    </div>
  )
}

function PreferencesSection({
  children,
  title
}: Readonly<{
  children: React.ReactNode
  title: string
}>): React.JSX.Element {
  return (
    <div className="preferences-section">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

/**
 * The original preferences screen, section by section, carrying the settings
 * this release keeps. Every path comes from the main-owned chooser and main
 * validates it before persisting, so the renderer never stores one of its own.
 */
export function PreferencesPage({
  onChanged,
  preferences
}: PreferencesPageProps): React.JSX.Element {
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
    <div className="preferences">
      <PreferencesSection title="Folders">
        <div className="preference">
          <PathSelector
            busy={busy}
            onChange={() =>
              void choose('directory', downloadRoot => ({ downloadRoot }))
            }
            title="Download location"
            value={preferences.downloadRoot}
          />
        </div>
        <div className="preference">
          <PathSelector
            busy={busy}
            onChange={() =>
              void choose('directory', torrentsFolder => ({ torrentsFolder }))
            }
            onClear={() => void clear({ torrentsFolder: null })}
            title="Folder to watch"
            value={preferences.torrentsFolder}
          />
          <p>New .torrent files in this folder are added immediately.</p>
        </div>
      </PreferencesSection>

      <PreferencesSection title="Playback">
        <div className="preference">
          <p>
            {preferences.externalPlayer === null
              ? 'Torrent media files play in WebTorrent.'
              : 'Torrent media files play in the chosen player if WebTorrent cannot play them.'}
          </p>
          <PathSelector
            busy={busy}
            onChange={() =>
              void choose('application', externalPlayer => ({ externalPlayer }))
            }
            onClear={() => void clear({ externalPlayer: null })}
            title="External player"
            value={preferences.externalPlayer}
          />
        </div>
      </PreferencesSection>

      {failure ? (
        <div className="error" role="alert">
          {failure}
        </div>
      ) : null}
    </div>
  )
}
