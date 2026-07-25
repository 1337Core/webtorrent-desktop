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
