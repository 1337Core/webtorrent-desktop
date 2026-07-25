export type HeaderProps = Readonly<{
  canGoBack: boolean
  canGoForward: boolean
  onAdd: () => void
  onBack: () => void
  onForward: () => void
  showAdd: boolean
  title: string
}>

/**
 * The original application header: a centered title, back and forward
 * navigation on the left, and the add-torrent control on the right.
 */
export function Header({
  canGoBack,
  canGoForward,
  onAdd,
  onBack,
  onForward,
  showAdd,
  title
}: HeaderProps): React.JSX.Element {
  return (
    <div className="header" role="navigation">
      <div className="title ellipsis">{title}</div>
      <div className="nav left float-left">
        <i
          aria-disabled={!canGoBack}
          aria-label="Back"
          className={`icon back ${canGoBack ? '' : 'disabled'}`}
          onClick={() => canGoBack && onBack()}
          role="button"
          title="Back"
        >
          chevron_left
        </i>
        <i
          aria-disabled={!canGoForward}
          aria-label="Forward"
          className={`icon forward ${canGoForward ? '' : 'disabled'}`}
          onClick={() => canGoForward && onForward()}
          role="button"
          title="Forward"
        >
          chevron_right
        </i>
      </div>
      <div className="nav right float-right">
        {showAdd ? (
          <i
            aria-label="Add torrent"
            className="icon add"
            onClick={onAdd}
            role="button"
            title="Add torrent"
          >
            add
          </i>
        ) : null}
      </div>
    </div>
  )
}
