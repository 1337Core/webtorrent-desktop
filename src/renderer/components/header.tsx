export type HeaderProps = Readonly<{
  canGoBack: boolean
  onAdd: () => void
  onBack: () => void
  showAdd: boolean
  title: string
}>

/**
 * The original application header: a centered title with back navigation on
 * the left and the add-torrent control on the right. Forward navigation is
 * absent because this build has no history beyond one level.
 */
export function Header({
  canGoBack,
  onAdd,
  onBack,
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
