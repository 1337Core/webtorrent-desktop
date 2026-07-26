import { useCallback, useState } from 'react'
import {
  collectFilePages,
  runCommand,
  type EngineValue
} from '../lib/engine-client'

type LegacyEntry = EngineValue<'list-legacy-imports'>['items'][number]

const LEGACY_PAGE_LIMIT = 64

type PreferenceValues = Readonly<{
  downloadRoot: string | null
  externalPlayer: string | null
  openAtLogin: boolean
  torrentsFolder: string | null
}>

export type PreferencesPageProps = Readonly<{
  onChanged: (preferences: PreferenceValues) => void
  /** Raised after an import so the library reloads what it gained. */
  onImported?: () => void
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
  onImported,
  preferences
}: PreferencesPageProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [legacyRoot, setLegacyRoot] = useState<string | null>(null)
  const [legacyEntries, setLegacyEntries] = useState<
    ReadonlyArray<LegacyEntry>
  >([])
  const [legacySkipped, setLegacySkipped] = useState(0)
  const [importReport, setImportReport] = useState<string | null>(null)

  const save = useCallback(
    async (
      update: Readonly<{
        downloadRoot?: string
        externalPlayer?: string | null
        openAtLogin?: boolean
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

  /**
   * Section 10.2's "Later" route: the original profile is chosen explicitly,
   * read without being opened for writing, and reported before anything is
   * imported. Nothing here touches the original app's data.
   */
  const scanLegacyRoot = useCallback(async () => {
    setBusy(true)
    setFailure(null)
    setImportReport(null)
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

    const root = chosen.value.path
    let skipped = 0
    const listed = await collectFilePages<LegacyEntry>(async cursor => {
      const page = await runCommand({
        command: 'list-legacy-imports',
        payload: { cursor, legacyRoot: root, limit: LEGACY_PAGE_LIMIT }
      })
      if (page.ok) skipped = page.value.skippedCount
      return page
    })
    setBusy(false)
    if (!listed.ok) {
      setFailure(listed.error.displayMessage)
      return
    }
    setLegacyRoot(root)
    setLegacyEntries(listed.items)
    setLegacySkipped(skipped)
  }, [])

  const importLegacy = useCallback(async () => {
    const destinationRoot = preferences.downloadRoot
    if (legacyRoot === null || destinationRoot === null) return
    setBusy(true)
    setFailure(null)

    let imported = 0
    let failed = 0
    for (const entry of legacyEntries) {
      if (entry.kind !== 'importable') continue
      const outcome = await runCommand({
        command: 'import-legacy-torrent',
        payload: { destinationRoot, infoHash: entry.infoHash, legacyRoot }
      })
      if (outcome.ok) imported += 1
      else failed += 1
    }

    setBusy(false)
    // Invalid entries are reported rather than aborting the whole import.
    setImportReport(
      `Imported ${imported} torrent${imported === 1 ? '' : 's'}` +
        (failed > 0 ? `, ${failed} could not be imported` : '') +
        (legacySkipped > 0 ? `, ${legacySkipped} skipped by the reader` : '') +
        '.'
    )
    setLegacyEntries([])
    if (imported > 0) onImported?.()
  }, [
    legacyEntries,
    legacyRoot,
    legacySkipped,
    onImported,
    preferences.downloadRoot
  ])

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

      <PreferencesSection title="Import">
        <div className="preference">
          <p>
            Bring settings and torrents over from the original WebTorrent
            Desktop. Its data is only read: nothing there is moved, changed, or
            deleted.
          </p>
          <div className="path-selector">
            <div className="label">
              <label htmlFor="legacy-profile">Original profile:</label>
            </div>
            <input
              className="control"
              disabled
              id="legacy-profile"
              readOnly
              value={legacyRoot ?? ''}
            />
            <button
              className="control"
              disabled={busy}
              onClick={() => void scanLegacyRoot()}
              type="button"
            >
              Choose
            </button>
          </div>
          {legacyEntries.length > 0 ? (
            <>
              <div className="file-list">
                {legacyEntries.map((entry, index) => (
                  <div key={`${entry.name}-${index}`}>
                    {entry.kind === 'importable'
                      ? `${entry.name} (${entry.fileCount} files)`
                      : `${entry.name} — cannot be imported`}
                  </div>
                ))}
              </div>
              <button
                className="control"
                disabled={busy || preferences.downloadRoot === null}
                onClick={() => void importLegacy()}
                type="button"
              >
                Import
              </button>
              {preferences.downloadRoot === null ? (
                <p>Choose a download location before importing.</p>
              ) : null}
            </>
          ) : null}
          {importReport ? <p role="status">{importReport}</p> : null}
        </div>
      </PreferencesSection>

      <PreferencesSection title="Startup">
        <div className="preference">
          <label className="control checkbox">
            <input
              checked={preferences.openAtLogin}
              disabled={busy}
              onChange={event => {
                setBusy(true)
                void save({ openAtLogin: event.target.checked })
              }}
              type="checkbox"
            />
            <span>Open WebTorrent Updated at login</span>
          </label>
          <p>
            An imported setting is only a stored choice until it is confirmed
            here.
          </p>
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
