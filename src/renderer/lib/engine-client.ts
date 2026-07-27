import type { EngineCommand, EngineCommandResult } from '../../shared/contracts'

type EngineSuccess = Extract<EngineCommandResult, { ok: true }>['result']

export type EngineValue<TCommand extends EngineCommand['command']> = Extract<
  EngineSuccess,
  { command: TCommand }
>['value']

export type EngineFailure = Readonly<{
  code: string
  displayMessage: string
  retryable: boolean
}>

export type EngineOutcome<TCommand extends EngineCommand['command']> =
  | Readonly<{ ok: true; value: EngineValue<TCommand> }>
  | Readonly<{ error: EngineFailure; ok: false }>

const TRANSPORT_FAILURE: EngineFailure = {
  code: 'TRANSPORT_FAILED',
  displayMessage: 'The application could not reach the torrent engine.',
  retryable: true
}

/**
 * The renderer's only route to the engine.
 *
 * Every result is already schema-validated by the preload capability; this
 * narrows it to the requested command and turns transport and protocol
 * failures into the same shape as an engine error, so views never branch on
 * where a failure came from.
 */
export async function runCommand<TOperation extends EngineCommand>(
  operation: TOperation
): Promise<EngineOutcome<TOperation['command']>> {
  const response = await window.desktop.runTorrentCommand(operation)
  if (!response.ok) {
    return {
      error: {
        code: response.error.code,
        displayMessage: response.error.displayMessage,
        retryable: response.error.retryable
      },
      ok: false
    }
  }

  const result = response.value
  if (!result.ok) {
    return {
      error: {
        code: result.error.code,
        displayMessage: result.error.displayMessage,
        retryable: result.error.retryable
      },
      ok: false
    }
  }
  if (result.result.command !== operation.command) {
    return { error: TRANSPORT_FAILURE, ok: false }
  }

  return {
    ok: true,
    value: result.result.value as EngineValue<TOperation['command']>
  }
}

/** One manifest page, whichever command produced it. */
type FilePage<TItem> = Readonly<{
  items: ReadonlyArray<TItem>
  nextCursor: number | null
}>

/**
 * A whole file manifest, not just its first page.
 *
 * The engine pages its manifests, so a torrent with more files than one page
 * holds would otherwise leave the rest unreviewable and unselectable. Paging
 * stops at the engine's own end marker, and a cursor that fails to advance
 * ends the walk rather than repeating a page forever.
 */
export async function collectFilePages<TItem>(
  fetchPage: (
    cursor: number
  ) => Promise<
    | Readonly<{ ok: true; value: FilePage<TItem> }>
    | Readonly<{ error: EngineFailure; ok: false }>
  >
): Promise<
  | Readonly<{ items: ReadonlyArray<TItem>; ok: true }>
  | Readonly<{ error: EngineFailure; ok: false }>
> {
  const items: TItem[] = []
  let cursor: number | null = 0

  while (cursor !== null) {
    const outcome = await fetchPage(cursor)
    if (!outcome.ok) return { error: outcome.error, ok: false }

    items.push(...outcome.value.items)
    const next = outcome.value.nextCursor
    if (next === null || next <= cursor || outcome.value.items.length === 0) {
      break
    }
    cursor = next
  }

  return { items, ok: true }
}
