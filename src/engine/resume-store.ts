import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { stat } from 'node:fs/promises'

export const RESUME_SCHEMA_VERSION = 1

const RESUME_LIMITS = Object.freeze({
  debounceMs: 5_000,
  maxFiles: 100_000,
  maxSidecarBytes: 4_000_000
})

export type ResumeStoreErrorCode =
  'INVALID_SIDECAR' | 'IO_FAILED' | 'NOT_FOUND' | 'PATH_NOT_AUTHORIZED'

export class ResumeStoreError extends Error {
  readonly code: ResumeStoreErrorCode

  constructor(code: ResumeStoreErrorCode) {
    super(`Resume sidecar operation failed: ${code}.`)
    this.name = 'ResumeStoreError'
    this.code = code
  }
}

type ResumeFileFingerprint = Readonly<{
  length: number
  mtimeMs: number
  path: string
  size: number
}>

export type ResumeSidecar = Readonly<{
  bitfield: string
  cleanShutdown: boolean
  fileCount: number
  files: ReadonlyArray<ResumeFileFingerprint>
  infoHash: string
  length: number
  pieceCount: number
  pieceLength: number
  root: string
  schemaVersion: number
  selectedPaths: ReadonlyArray<string>
}>

export type ResumeExpectation = Readonly<{
  files: ReadonlyArray<Readonly<{ length: number; path: string }>>
  infoHash: string
  length: number
  pieceCount: number
  pieceLength: number
  root: string
  selectedPaths: ReadonlyArray<string>
}>

export type ResumeDecision =
  | Readonly<{ bitfield: Uint8Array; usable: true }>
  | Readonly<{
      reason:
        | 'CHECKSUM_MISMATCH'
        | 'FILE_CHANGED'
        | 'FILE_MISSING'
        | 'GEOMETRY_MISMATCH'
        | 'IDENTITY_MISMATCH'
        | 'MANIFEST_MISMATCH'
        | 'SCHEMA_MISMATCH'
        | 'SELECTION_MISMATCH'
        | 'UNCLEAN_SHUTDOWN'
      usable: false
    }>

type SidecarEnvelope = ResumeSidecar & { checksum: string }

function checksumOf(sidecar: ResumeSidecar): string {
  // Field order is fixed here rather than taken from the parsed object, so a
  // reordered or extended file cannot reproduce a valid checksum.
  const canonical = JSON.stringify([
    sidecar.schemaVersion,
    sidecar.infoHash,
    sidecar.root,
    sidecar.length,
    sidecar.pieceLength,
    sidecar.pieceCount,
    sidecar.fileCount,
    sidecar.cleanShutdown,
    sidecar.bitfield,
    [...sidecar.selectedPaths],
    sidecar.files.map(file => [file.path, file.length, file.size, file.mtimeMs])
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

function isSidecar(value: unknown): value is SidecarEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.bitfield === 'string' &&
    typeof candidate.checksum === 'string' &&
    typeof candidate.cleanShutdown === 'boolean' &&
    typeof candidate.fileCount === 'number' &&
    Array.isArray(candidate.files) &&
    typeof candidate.infoHash === 'string' &&
    typeof candidate.length === 'number' &&
    typeof candidate.pieceCount === 'number' &&
    typeof candidate.pieceLength === 'number' &&
    typeof candidate.root === 'string' &&
    typeof candidate.schemaVersion === 'number' &&
    Array.isArray(candidate.selectedPaths)
  )
}

function sameStrings(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  )
}

/**
 * Persists one app-owned fast-resume sidecar per torrent.
 *
 * WebTorrent's undocumented `fileModtimes` shortcut is never used and
 * `skipVerify` is never set automatically: a saved bitfield is offered only
 * when the schema, identity, manifest, geometry, checksum, clean-shutdown
 * marker, and every stat fingerprint match. Anything else means a full
 * verification. The bitfield is a local performance hint, not an integrity
 * guarantee.
 */
export class ResumeStore {
  readonly #directory: string
  readonly #statFile: (target: string) => Promise<{
    mtimeMs: number
    size: number
  }>

  constructor(
    options: Readonly<{
      directory: string
      statFile?: (target: string) => Promise<{ mtimeMs: number; size: number }>
    }>
  ) {
    if (!path.isAbsolute(options.directory)) {
      throw new ResumeStoreError('PATH_NOT_AUTHORIZED')
    }
    this.#directory = path.resolve(options.directory)
    this.#statFile =
      options.statFile ??
      (async target => {
        const stats = await stat(target)
        return { mtimeMs: stats.mtimeMs, size: stats.size }
      })
  }

  sidecarPath(infoHash: string): string {
    if (!/^[0-9a-f]{40}$/u.test(infoHash)) {
      throw new ResumeStoreError('PATH_NOT_AUTHORIZED')
    }
    return path.join(this.#directory, `${infoHash}.resume.json`)
  }

  /** Builds a sidecar from live state; the caller decides when to persist. */
  async describe(
    input: Readonly<{
      bitfield: Uint8Array
      cleanShutdown: boolean
      expectation: ResumeExpectation
    }>
  ): Promise<ResumeSidecar> {
    const { expectation } = input
    if (expectation.files.length > RESUME_LIMITS.maxFiles) {
      throw new ResumeStoreError('INVALID_SIDECAR')
    }

    const files: ResumeFileFingerprint[] = []
    for (const file of expectation.files) {
      const target = path.resolve(expectation.root, file.path)
      let fingerprint = { mtimeMs: 0, size: -1 }
      try {
        fingerprint = await this.#statFile(target)
      } catch {
        // An absent deselected file is recorded as absent rather than failing
        // the whole sidecar; the match check treats it as a mismatch later.
      }
      files.push({
        length: file.length,
        mtimeMs: fingerprint.mtimeMs,
        path: file.path,
        size: fingerprint.size
      })
    }

    return {
      bitfield: Buffer.from(input.bitfield).toString('base64'),
      cleanShutdown: input.cleanShutdown,
      fileCount: expectation.files.length,
      files,
      infoHash: expectation.infoHash,
      length: expectation.length,
      pieceCount: expectation.pieceCount,
      pieceLength: expectation.pieceLength,
      root: expectation.root,
      schemaVersion: RESUME_SCHEMA_VERSION,
      selectedPaths: [...expectation.selectedPaths]
    }
  }

  /** Atomic: a torn write can never replace a good sidecar. */
  async save(sidecar: ResumeSidecar): Promise<void> {
    const target = this.sidecarPath(sidecar.infoHash)
    const temporary = `${target}.${process.pid}.tmp`
    const payload = JSON.stringify({
      ...sidecar,
      checksum: checksumOf(sidecar)
    })
    if (Buffer.byteLength(payload) > RESUME_LIMITS.maxSidecarBytes) {
      throw new ResumeStoreError('INVALID_SIDECAR')
    }

    try {
      await mkdir(this.#directory, { mode: 0o700, recursive: true })
      const handle = await open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } catch {
      await unlink(temporary).catch(() => undefined)
      throw new ResumeStoreError('IO_FAILED')
    }
  }

  async load(infoHash: string): Promise<ResumeSidecar | null> {
    let raw: string
    try {
      raw = await readFile(this.sidecarPath(infoHash), 'utf8')
    } catch {
      return null
    }
    if (Buffer.byteLength(raw) > RESUME_LIMITS.maxSidecarBytes) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isSidecar(parsed)) return null

    const { checksum, ...sidecar } = parsed
    if (checksumOf(sidecar) !== checksum) return null
    return sidecar
  }

  async remove(infoHash: string): Promise<void> {
    await unlink(this.sidecarPath(infoHash)).catch(() => undefined)
  }

  /**
   * Offers the saved bitfield only when everything matches. Any mismatch,
   * including one changed or missing file, invalidates the whole bitfield.
   */
  async evaluate(
    expectation: ResumeExpectation,
    sidecar: ResumeSidecar | null
  ): Promise<ResumeDecision> {
    if (!sidecar) return { reason: 'SCHEMA_MISMATCH', usable: false }
    if (sidecar.schemaVersion !== RESUME_SCHEMA_VERSION) {
      return { reason: 'SCHEMA_MISMATCH', usable: false }
    }
    if (!sidecar.cleanShutdown) {
      return { reason: 'UNCLEAN_SHUTDOWN', usable: false }
    }
    if (
      sidecar.infoHash !== expectation.infoHash ||
      path.resolve(sidecar.root) !== path.resolve(expectation.root)
    ) {
      return { reason: 'IDENTITY_MISMATCH', usable: false }
    }
    if (
      sidecar.pieceLength !== expectation.pieceLength ||
      sidecar.pieceCount !== expectation.pieceCount ||
      sidecar.length !== expectation.length
    ) {
      return { reason: 'GEOMETRY_MISMATCH', usable: false }
    }
    if (
      sidecar.fileCount !== expectation.files.length ||
      sidecar.files.length !== expectation.files.length ||
      sidecar.files.some(
        (file, index) =>
          file.path !== expectation.files[index]?.path ||
          file.length !== expectation.files[index]?.length
      )
    ) {
      return { reason: 'MANIFEST_MISMATCH', usable: false }
    }
    if (!sameStrings(sidecar.selectedPaths, expectation.selectedPaths)) {
      return { reason: 'SELECTION_MISMATCH', usable: false }
    }

    for (const file of sidecar.files) {
      const target = path.resolve(expectation.root, file.path)
      let fingerprint
      try {
        fingerprint = await this.#statFile(target)
      } catch {
        return { reason: 'FILE_MISSING', usable: false }
      }
      if (
        fingerprint.size !== file.size ||
        fingerprint.mtimeMs !== file.mtimeMs
      ) {
        return { reason: 'FILE_CHANGED', usable: false }
      }
    }

    let bitfield: Buffer
    try {
      bitfield = Buffer.from(sidecar.bitfield, 'base64')
    } catch {
      return { reason: 'CHECKSUM_MISMATCH', usable: false }
    }
    if (bitfield.byteLength !== Math.ceil(expectation.pieceCount / 8)) {
      return { reason: 'GEOMETRY_MISMATCH', usable: false }
    }
    return { bitfield: new Uint8Array(bitfield), usable: true }
  }
}
