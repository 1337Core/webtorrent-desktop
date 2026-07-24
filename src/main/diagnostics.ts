import path from 'node:path'
import { isIP } from 'node:net'
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'

const MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_FILES = 3
const MAX_QUEUED_RECORDS = 256
const MAX_RECORD_BYTES = 4 * 1024
const MAX_STRING_LENGTH = 2048
const DEFAULT_FLUSH_TIMEOUT_MS = 2000
const MAX_FLUSH_TIMEOUT_MS = 10_000
const SENSITIVE_DETAIL_KEY =
  /(?:authorization|cookie|credential|password|passkey|secret|token|api[_-]?key|magnet|tracker|webseed|peer|address|hostname|file(?:name|path)?|directory|(?:^|[_-])path(?:$|[_-])|(?:^|[_-])url(?:$|[_-])|(?:^|[_-])uri(?:$|[_-]))/iu

export type DiagnosticLevel = 'info' | 'warn' | 'error'
export type DiagnosticDetails = Readonly<Record<string, unknown>>

function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      return '[url]'
    }

    const hostname = url.hostname.replace(/^\[|\]$/gu, '')
    const safeHostname = isIP(hostname.split('%', 1)[0] ?? '')
      ? '[ip]'
      : hostname

    return `${url.protocol}//${safeHostname}${url.port ? `:${url.port}` : ''}/[redacted]`
  } catch {
    return '[url]'
  }
}

function redactIpAddresses(value: string): string {
  return value
    .replace(/\[([^\]\s]+)\](?::\d{1,5})?/gu, (candidate, address: string) => {
      const withoutZone = address.split('%', 1)[0] ?? ''
      return isIP(withoutZone) === 6 ? '[ip]' : candidate
    })
    .replace(
      /(?<![a-f\d:])(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}(?:%[a-z\d_.-]+)?(?![a-f\d:])/giu,
      candidate => {
        const withoutZone = candidate.split('%', 1)[0] ?? ''
        return isIP(withoutZone) === 6 ? '[ip]' : candidate
      }
    )
    .replace(
      /\b((?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?\b/gu,
      (candidate, address: string) => (isIP(address) === 4 ? '[ip]' : candidate)
    )
}

function removeControlCharacters(value: string): string {
  let sanitized = ''

  for (const character of value.slice(0, MAX_STRING_LENGTH)) {
    const codePoint = character.codePointAt(0) ?? 0
    const isUnsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    sanitized += isUnsafe ? ' ' : character
  }

  return sanitized
}

export function redactText(value: string): string {
  const bounded = removeControlCharacters(value)

  const redacted = bounded
    .replace(/magnet:\?[^\s"'<>]*/giu, 'magnet:[redacted]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/giu, candidate =>
      redactUrl(candidate)
    )
    .replace(/(["'])(?:~\/|\/)[^"'\r\n]+\1/gu, '[path]')
    .replace(
      /(^|[\s=(:,;])(?:~\/|\/)[^\s"'<>),;]+/gu,
      (_candidate, prefix: string) => `${prefix}[path]`
    )
    .replace(
      /(^|[\s=(:,;])[a-z]:\\[^\s"'<>),;]+/giu,
      (_candidate, prefix: string) => `${prefix}[path]`
    )
    .replace(
      /\b(?:authorization|cookie|credential|password|passkey|secret|token|auth|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^&\s,;}]+)/giu,
      'secret=[redacted]'
    )

  return redactIpAddresses(redacted)
}

function sanitizeValue(value: unknown, depth = 0, detailKey?: string): unknown {
  if (detailKey && SENSITIVE_DETAIL_KEY.test(detailKey)) return '[redacted]'
  if (depth > 4) return '[truncated]'
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : '[non-finite]'
  }
  if (value instanceof Error) {
    return {
      name: redactText(value.name).slice(0, 96),
      message: redactText(value.message)
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    let count = 0

    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (count >= 40) break

      const safeKey = redactText(key).slice(0, 96)
      sanitized[safeKey] = sanitizeValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        key
      )
      count += 1
    }

    return sanitized
  }

  return '[unsupported]'
}

function createRecordLine(
  level: DiagnosticLevel,
  code: string,
  details: DiagnosticDetails
): string {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    code: redactText(code).slice(0, 96),
    details: sanitizeValue(details)
  }

  let line: string
  try {
    line = `${JSON.stringify(record)}\n`
  } catch {
    line = `${JSON.stringify({
      ...record,
      details: { truncated: true, reason: 'invalid-details' }
    })}\n`
  }

  const originalBytes = Buffer.byteLength(line)
  if (originalBytes <= MAX_RECORD_BYTES) return line

  return `${JSON.stringify({
    ...record,
    details: {
      truncated: true,
      originalBytes
    }
  })}\n`
}

async function ignoreMissing(operation: Promise<unknown>): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
}

export class Diagnostics {
  readonly #logPath: string
  readonly #pendingLines: string[] = []
  #drainPromise: Promise<void> | null = null
  #droppedRecords = 0

  constructor(logDirectory: string) {
    this.#logPath = path.join(logDirectory, 'application.jsonl')
  }

  info(code: string, details: DiagnosticDetails = {}): void {
    this.#enqueue('info', code, details)
  }

  warn(code: string, details: DiagnosticDetails = {}): void {
    this.#enqueue('warn', code, details)
  }

  error(code: string, details: DiagnosticDetails = {}): void {
    this.#enqueue('error', code, details)
  }

  async flush(timeoutMilliseconds = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    const boundedTimeout = Number.isFinite(timeoutMilliseconds)
      ? Math.max(
          0,
          Math.min(MAX_FLUSH_TIMEOUT_MS, Math.trunc(timeoutMilliseconds))
        )
      : DEFAULT_FLUSH_TIMEOUT_MS
    const drainPromise = this.#waitForIdle()
    let timeout: NodeJS.Timeout | undefined

    await Promise.race([
      drainPromise,
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, boundedTimeout)
        timeout.unref()
      })
    ])

    if (timeout) clearTimeout(timeout)
  }

  #enqueue(
    level: DiagnosticLevel,
    code: string,
    details: DiagnosticDetails
  ): void {
    if (this.#pendingLines.length >= MAX_QUEUED_RECORDS) {
      this.#droppedRecords = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.#droppedRecords + 1
      )
      return
    }

    let line: string
    try {
      line = createRecordLine(level, code, details)
    } catch {
      line = createRecordLine('error', 'diagnostics.invalid-record', {})
    }

    this.#pendingLines.push(line)
    this.#startDrain()
  }

  #startDrain(): void {
    if (this.#drainPromise) return

    const drainPromise = this.#drain()
    this.#drainPromise = drainPromise
    void drainPromise.finally(() => {
      if (this.#drainPromise === drainPromise) this.#drainPromise = null
      if (this.#pendingLines.length > 0 || this.#droppedRecords > 0) {
        this.#startDrain()
      }
    })
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pendingLines.length > 0 || this.#droppedRecords > 0) {
        const line = this.#pendingLines.shift()
        if (line) {
          await this.#write(line)
          continue
        }

        const droppedRecords = this.#droppedRecords
        this.#droppedRecords = 0
        await this.#write(
          createRecordLine('warn', 'diagnostics.records-dropped', {
            count: droppedRecords
          })
        )
      }
    } catch {
      this.#pendingLines.length = 0
      this.#droppedRecords = 0
      // Diagnostics must never crash or indefinitely back up the application.
    }
  }

  async #waitForIdle(): Promise<void> {
    while (this.#drainPromise) {
      await this.#drainPromise
    }
  }

  async #write(line: string): Promise<void> {
    await mkdir(path.dirname(this.#logPath), {
      recursive: true,
      mode: 0o700
    })

    let currentSize = 0
    try {
      currentSize = (await stat(this.#logPath)).size
    } catch {
      // The first log write has no existing file.
    }

    if (currentSize + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      await this.#rotate()
    }

    await appendFile(this.#logPath, line, {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  async #rotate(): Promise<void> {
    await ignoreMissing(
      rm(`${this.#logPath}.${MAX_LOG_FILES}`, { force: true })
    )

    for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
      await ignoreMissing(
        rename(`${this.#logPath}.${index}`, `${this.#logPath}.${index + 1}`)
      )
    }

    await ignoreMissing(rename(this.#logPath, `${this.#logPath}.1`))
  }
}
