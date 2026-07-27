import { constants, type Stats } from 'node:fs'
import { open as openFile, type FileHandle } from 'node:fs/promises'

export const LOCAL_TORRENT_MAX_BYTES = 10_000_000

const READ_CHUNK_BYTES = 64 * 1024
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export type LocalTorrentReadErrorCode =
  | 'ABORTED'
  | 'CLOSE_FAILED'
  | 'FILE_TOO_LARGE'
  | 'NOT_REGULAR_FILE'
  | 'OPEN_FAILED'
  | 'READ_FAILED'

export class LocalTorrentReadError extends Error {
  readonly code: LocalTorrentReadErrorCode

  constructor(code: LocalTorrentReadErrorCode) {
    super(`Local torrent file was rejected: ${code}.`)
    this.name = 'LocalTorrentReadError'
    this.code = code
  }
}

export type LocalTorrentReadOptions = Readonly<{
  signal?: AbortSignal
}>

type LocalTorrentStat = Pick<Stats, 'isFile' | 'size'>

type LocalTorrentFileHandle = Readonly<{
  close: () => Promise<void>
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => Promise<Readonly<{ bytesRead: number }>>
  stat: () => Promise<LocalTorrentStat>
}>

type LocalTorrentFileOpener = (
  filePath: string,
  flags: number
) => Promise<LocalTorrentFileHandle>

function aborted(): LocalTorrentReadError {
  return new LocalTorrentReadError('ABORTED')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw aborted()
}

function translateReadError(
  error: unknown,
  signal: AbortSignal | undefined
): LocalTorrentReadError {
  if (error instanceof LocalTorrentReadError) return error
  return signal?.aborted ? aborted() : new LocalTorrentReadError('READ_FAILED')
}

async function readFromDescriptor(
  handle: LocalTorrentFileHandle,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  throwIfAborted(signal)
  const initialStat = await handle.stat()
  throwIfAborted(signal)

  if (!initialStat.isFile()) {
    throw new LocalTorrentReadError('NOT_REGULAR_FILE')
  }
  if (
    !Number.isSafeInteger(initialStat.size) ||
    initialStat.size < 0 ||
    initialStat.size > LOCAL_TORRENT_MAX_BYTES
  ) {
    throw new LocalTorrentReadError('FILE_TOO_LARGE')
  }

  const chunks: Uint8Array[] = []
  let position = 0
  while (true) {
    throwIfAborted(signal)
    const remainingBytes = LOCAL_TORRENT_MAX_BYTES - position
    const nextReadBytes = Math.min(
      READ_CHUNK_BYTES,
      remainingBytes === 0 ? 1 : remainingBytes
    )
    const chunk = new Uint8Array(nextReadBytes)
    const result = await handle.read(chunk, 0, chunk.byteLength, position)
    throwIfAborted(signal)

    if (
      !Number.isSafeInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > chunk.byteLength
    ) {
      throw new LocalTorrentReadError('READ_FAILED')
    }
    if (result.bytesRead === 0) break

    position += result.bytesRead
    if (position > LOCAL_TORRENT_MAX_BYTES) {
      throw new LocalTorrentReadError('FILE_TOO_LARGE')
    }
    chunks.push(chunk.subarray(0, result.bytesRead))
  }

  const finalStat = await handle.stat()
  throwIfAborted(signal)
  if (!finalStat.isFile()) {
    throw new LocalTorrentReadError('NOT_REGULAR_FILE')
  }
  if (
    !Number.isSafeInteger(finalStat.size) ||
    finalStat.size < 0 ||
    finalStat.size > LOCAL_TORRENT_MAX_BYTES
  ) {
    throw new LocalTorrentReadError('FILE_TOO_LARGE')
  }
  if (finalStat.size !== initialStat.size || position !== finalStat.size) {
    throw new LocalTorrentReadError('READ_FAILED')
  }

  const bytes = new Uint8Array(position)
  let outputOffset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, outputOffset)
    outputOffset += chunk.byteLength
  }
  return bytes
}

/**
 * Creates the local torrent reader. The opener argument exists so descriptor
 * races and failure paths can be tested without weakening the production API.
 */
export function createLocalTorrentReader(
  opener: LocalTorrentFileOpener = async (
    filePath,
    flags
  ): Promise<FileHandle> => await openFile(filePath, flags)
): (
  filePath: string,
  options?: LocalTorrentReadOptions
) => Promise<Uint8Array> {
  return async (filePath, options = {}) => {
    throwIfAborted(options.signal)

    let handle: LocalTorrentFileHandle
    try {
      handle = await opener(filePath, OPEN_FLAGS)
    } catch {
      throw options.signal?.aborted
        ? aborted()
        : new LocalTorrentReadError('OPEN_FAILED')
    }

    let bytes: Uint8Array | undefined
    let failure: LocalTorrentReadError | undefined
    try {
      bytes = await readFromDescriptor(handle, options.signal)
    } catch (error) {
      failure = translateReadError(error, options.signal)
    }

    try {
      await handle.close()
    } catch {
      failure ??= new LocalTorrentReadError('CLOSE_FAILED')
    }
    if (!failure && options.signal?.aborted) failure = aborted()

    if (failure) throw failure
    if (!bytes) throw new LocalTorrentReadError('READ_FAILED')
    return bytes
  }
}

export const readLocalTorrentFile = createLocalTorrentReader()
