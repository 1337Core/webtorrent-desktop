export type UnsupportedMediaModalProps = Readonly<{
  /** The configured player's display name; absent until one is chosen. */
  externalPlayerName: string | null
  /** Set when the configured player itself could not be launched. */
  externalPlayerFailed?: boolean
  message: string
  onCancel: () => void
  onPlayExternally: () => void
}>

/**
 * The original "we can't play that file" modal, offering the configured
 * external player. The original also offered to install VLC; this release does
 * not send the owner to a download page, so that option is simply absent.
 */
export function UnsupportedMediaModal({
  externalPlayerName,
  externalPlayerFailed = false,
  message,
  onCancel,
  onPlayExternally
}: UnsupportedMediaModalProps): React.JSX.Element {
  return (
    <div>
      <p>
        <strong>Sorry, we can&apos;t play that file.</strong>
      </p>
      <p>{message}</p>
      <div className="float-right">
        <button className="control cancel" onClick={onCancel} type="button">
          CANCEL
        </button>
        {externalPlayerName === null ? null : (
          <button
            className="control ok"
            onClick={onPlayExternally}
            type="button"
          >
            {`PLAY IN ${externalPlayerName.toUpperCase()}`}
          </button>
        )}
      </div>
      {externalPlayerFailed ? (
        <p className="error-text">
          Couldn&apos;t run external player. Please make sure it&apos;s
          installed.
        </p>
      ) : null}
    </div>
  )
}
