import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { Readable } from 'node:stream'

export const MEDIA_PROXY_LIMITS = Object.freeze({
  applicationOrigin: 'app://bundle',
  host: '127.0.0.1',
  leaseTtlMs: 60_000,
  maxLeases: 8,
  routePrefix: '/v1/media/',
  tokenBytes: 32
})

export type MediaProxyErrorCode =
  'CAPACITY_EXCEEDED' | 'CLOSED' | 'NOT_FOUND' | 'START_FAILED'

export class MediaProxyError extends Error {
  readonly code: MediaProxyErrorCode

  constructor(code: MediaProxyErrorCode) {
    super(`Media proxy operation failed: ${code}.`)
    this.name = 'MediaProxyError'
    this.code = code
  }
}

export type MediaSource = Readonly<{
  /** Bounded byte range from the selected file, never a raw server URL. */
  createReadStream: (
    range: Readonly<{ end: number; start: number }>
  ) => Readable
  contentType: string
  length: number
}>

export type MediaLease = Readonly<{
  expiresAtMs: number
  fileIndex: number
  infoHash: string
  leaseId: string
  url: string
}>

export type MediaProxyOptions = Readonly<{
  createId?: () => string
  createToken?: () => string
  now?: () => number
  ttlMs?: number
}>

type LeaseRecord = {
  expiresAtMs: number
  fileIndex: number
  infoHash: string
  leaseId: string
  source: MediaSource
  token: string
}

function encodeToken(): string {
  return randomBytes(MEDIA_PROXY_LIMITS.tokenBytes).toString('base64url')
}

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

/**
 * One engine-lifetime loopback proxy for media playback.
 *
 * WebTorrent's built-in server is never exposed: its `origin` option only sets
 * CORS headers, and a shared pathname lets a holder of one file URL discover
 * index routes by truncation. This mints an independent high-entropy token per
 * selected file, maps no index route, and revokes on close, removal, or
 * engine restart.
 */
export class MediaProxy {
  readonly #createId: () => string
  readonly #createToken: () => string
  readonly #leasesById = new Map<string, LeaseRecord>()
  readonly #leasesByToken = new Map<string, LeaseRecord>()
  readonly #now: () => number
  readonly #ttlMs: number
  #closed = false
  #port = 0
  #server: Server | null = null

  constructor(options: MediaProxyOptions = {}) {
    this.#createId = options.createId ?? randomUUID
    this.#createToken = options.createToken ?? encodeToken
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.ttlMs ?? MEDIA_PROXY_LIMITS.leaseTtlMs
  }

  get port(): number {
    return this.#port
  }

  get leaseCount(): number {
    return this.#leasesById.size
  }

  async start(): Promise<number> {
    if (this.#closed) throw new MediaProxyError('CLOSED')
    if (this.#server) return this.#port

    const server = createServer((request, response) => {
      this.#handle(request, response)
    })
    this.#server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Loopback only: never all interfaces.
      server.listen(0, MEDIA_PROXY_LIMITS.host)
    }).catch(() => {
      this.#server = null
      throw new MediaProxyError('START_FAILED')
    })

    const address = server.address()
    if (typeof address === 'string' || address === null) {
      throw new MediaProxyError('START_FAILED')
    }
    this.#port = address.port
    return this.#port
  }

  open(
    input: Readonly<{
      fileIndex: number
      infoHash: string
      source: MediaSource
    }>
  ): MediaLease {
    if (this.#closed || !this.#server) throw new MediaProxyError('CLOSED')
    this.#expire()
    if (this.#leasesById.size >= MEDIA_PROXY_LIMITS.maxLeases) {
      throw new MediaProxyError('CAPACITY_EXCEEDED')
    }

    const record: LeaseRecord = {
      expiresAtMs: this.#now() + this.#ttlMs,
      fileIndex: input.fileIndex,
      infoHash: input.infoHash,
      leaseId: this.#createId(),
      source: input.source,
      token: this.#createToken()
    }
    this.#leasesById.set(record.leaseId, record)
    this.#leasesByToken.set(record.token, record)
    return this.#describe(record)
  }

  heartbeat(leaseId: string): MediaLease {
    this.#expire()
    const record = this.#leasesById.get(leaseId)
    if (!record) throw new MediaProxyError('NOT_FOUND')
    record.expiresAtMs = this.#now() + this.#ttlMs
    return this.#describe(record)
  }

  close(leaseId: string): boolean {
    const record = this.#leasesById.get(leaseId)
    if (!record) return false
    this.#revoke(record)
    return true
  }

  /** Torrent removal and pause revoke every lease the torrent owns. */
  revokeTorrent(infoHash: string): number {
    let revoked = 0
    for (const record of [...this.#leasesById.values()]) {
      if (record.infoHash !== infoHash) continue
      this.#revoke(record)
      revoked += 1
    }
    return revoked
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    for (const record of [...this.#leasesById.values()]) this.#revoke(record)
    const server = this.#server
    this.#server = null
    this.#port = 0
    if (!server) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  #describe(record: LeaseRecord): MediaLease {
    return {
      expiresAtMs: record.expiresAtMs,
      fileIndex: record.fileIndex,
      infoHash: record.infoHash,
      leaseId: record.leaseId,
      url: `http://${MEDIA_PROXY_LIMITS.host}:${this.#port}${MEDIA_PROXY_LIMITS.routePrefix}${record.token}`
    }
  }

  #revoke(record: LeaseRecord): void {
    this.#leasesById.delete(record.leaseId)
    this.#leasesByToken.delete(record.token)
  }

  #expire(): void {
    const now = this.#now()
    for (const record of [...this.#leasesById.values()]) {
      if (record.expiresAtMs <= now) this.#revoke(record)
    }
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? 'GET'
    if (method === 'OPTIONS') {
      response.writeHead(204, { allow: 'GET, HEAD, OPTIONS' })
      response.end()
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      this.#reject(response, 405)
      return
    }

    // An Origin is accepted only when it is exactly the application origin;
    // the packaged media element sends none, where the token is the authority.
    const origin = request.headers.origin
    if (
      origin !== undefined &&
      origin !== MEDIA_PROXY_LIMITS.applicationOrigin
    ) {
      this.#reject(response, 403)
      return
    }
    if (request.headers.host !== `${MEDIA_PROXY_LIMITS.host}:${this.#port}`) {
      this.#reject(response, 403)
      return
    }

    const record = this.#match(request.url ?? '')
    if (!record) {
      this.#reject(response, 404)
      return
    }

    const range = this.#range(request.headers.range, record.source.length)
    if (!range) {
      response.writeHead(416, {
        'content-range': `bytes */${record.source.length}`
      })
      response.end()
      return
    }

    const headers: Record<string, string> = {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-length': String(range.end - range.start + 1),
      'content-type': record.source.contentType,
      'x-content-type-options': 'nosniff'
    }
    if (range.partial) {
      headers['content-range'] =
        `bytes ${range.start}-${range.end}/${record.source.length}`
    }
    response.writeHead(range.partial ? 206 : 200, headers)
    if (method === 'HEAD') {
      response.end()
      return
    }

    const stream = record.source.createReadStream({
      end: range.end,
      start: range.start
    })
    stream.on('error', () => {
      response.destroy()
    })
    response.on('close', () => {
      stream.destroy()
    })
    stream.pipe(response)
  }

  /**
   * Only the exact token route resolves. There is no index, no directory, and
   * no prefix that reveals another lease.
   */
  #match(url: string): LeaseRecord | null {
    const pathname = url.split('?')[0] ?? ''
    if (!pathname.startsWith(MEDIA_PROXY_LIMITS.routePrefix)) return null
    const token = pathname.slice(MEDIA_PROXY_LIMITS.routePrefix.length)
    if (token === '' || token.includes('/')) return null

    this.#expire()
    for (const record of this.#leasesByToken.values()) {
      if (tokensMatch(record.token, token)) return record
    }
    return null
  }

  #range(
    header: string | undefined,
    length: number
  ): { end: number; partial: boolean; start: number } | null {
    if (header === undefined) {
      return { end: Math.max(length - 1, 0), partial: false, start: 0 }
    }
    // Exactly one bounded range; multipart ranges are never served.
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
    if (!match) return null
    const [, rawStart, rawEnd] = match
    if (rawStart === '' && rawEnd === '') return null

    let start: number
    let end: number
    if (rawStart === '') {
      const suffix = Number(rawEnd)
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
      start = Math.max(length - suffix, 0)
      end = length - 1
    } else {
      start = Number(rawStart)
      end = rawEnd === '' ? length - 1 : Number(rawEnd)
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= length
    ) {
      return null
    }
    return { end: Math.min(end, length - 1), partial: true, start }
  }

  #reject(response: ServerResponse, status: number): void {
    response.writeHead(status, { 'cache-control': 'no-store' })
    response.end()
  }
}
