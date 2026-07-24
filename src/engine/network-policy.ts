import { lookup as systemLookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import {
  Agent as UndiciAgent,
  buildConnector,
  fetch as undiciFetch
} from 'undici'

const DEFAULT_DNS_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 3
const REMOTE_TORRENT_MAX_BYTES = 10_000_000
const MAX_DNS_ANSWERS = 16
const MAX_RESPONSE_CHUNKS = 4_096
const MAX_URL_BYTES = 2_048
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type DnsRecord = Readonly<{
  address: string
  family: number
}>

type DnsLookup = (hostname: string) => Promise<ReadonlyArray<DnsRecord>>

export type EgressPolicyOptions = Readonly<{
  allowPrivateNetwork?: boolean
  dnsLookup?: DnsLookup
  dnsTimeoutMs?: number
  maxRedirects?: number
  requestTimeoutMs?: number
  testOnlyAllowLoopback?: boolean
}>

export type RemoteTorrentUrlOptions = Readonly<{
  allowHttp: boolean
  signal?: AbortSignal
}>

export type RemoteTorrentFetchResult = Readonly<{
  bytes: Uint8Array
  finalUrl: string
}>

type RemoteTorrentHop =
  | Readonly<{ kind: 'redirect'; location: string }>
  | Readonly<{ bytes: Uint8Array; kind: 'success' }>

class EgressPolicyError extends Error {
  readonly code:
    | 'ADDRESS_BLOCKED'
    | 'BODY_TOO_LARGE'
    | 'CONCURRENCY_LIMIT'
    | 'DNS_FAILED'
    | 'DNS_TIMEOUT'
    | 'HTTP_DISABLED'
    | 'HTTP_STATUS'
    | 'INVALID_URL'
    | 'REDIRECT_BLOCKED'
    | 'REQUEST_FAILED'
    | 'REQUEST_TIMEOUT'
    | 'RESPONSE_ENCODING_BLOCKED'
    | 'SCHEME_BLOCKED'
    | 'TRACKER_TRANSPORT_DISABLED'

  constructor(
    code: EgressPolicyError['code'],
    message = 'Network request was blocked by policy.'
  ) {
    super(message)
    this.name = 'EgressPolicyError'
    this.code = code
  }
}

function ipv4ToInteger(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function isInIpv4Range(
  value: number,
  network: number,
  prefixLength: number
): boolean {
  if (prefixLength === 0) return true
  const mask = (0xffffffff << (32 - prefixLength)) >>> 0
  return (value & mask) === (network & mask)
}

function isInNamedIpv4Range(
  address: string,
  network: string,
  prefixLength: number
): boolean {
  const value = ipv4ToInteger(address)
  const networkValue = ipv4ToInteger(network)
  return (
    value !== null &&
    networkValue !== null &&
    isInIpv4Range(value, networkValue, prefixLength)
  )
}

export function isPublicIpv4(address: string): boolean {
  const value = ipv4ToInteger(address)
  if (value === null) return false

  const blockedRanges: ReadonlyArray<readonly [string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ]

  return !blockedRanges.some(([network, prefixLength]) => {
    const networkValue = ipv4ToInteger(network)
    return (
      networkValue !== null && isInIpv4Range(value, networkValue, prefixLength)
    )
  })
}

export function isPrivateNetworkIpv4(address: string): boolean {
  return (
    isInNamedIpv4Range(address, '10.0.0.0', 8) ||
    isInNamedIpv4Range(address, '172.16.0.0', 12) ||
    isInNamedIpv4Range(address, '192.168.0.0', 16)
  )
}

function isLoopbackIpv4(address: string): boolean {
  return isInNamedIpv4Range(address, '127.0.0.0', 8)
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
  )
}

function parseNetworkUrl(value: string | URL): URL {
  let url: URL
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value)
  } catch {
    throw new EgressPolicyError('INVALID_URL')
  }

  if (
    new TextEncoder().encode(url.href).byteLength > MAX_URL_BYTES ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === '' ||
    url.hash !== ''
  ) {
    throw new EgressPolicyError('INVALID_URL')
  }
  if (url.port !== '') {
    const port = Number(url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new EgressPolicyError('INVALID_URL')
    }
  }
  return url
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  throw new EgressPolicyError('REQUEST_FAILED')
}

function createPinnedLookup(address: string): LookupFunction {
  return (_hostname, options, callback): void => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family: 4 }])
    } else {
      callback(null, address, 4)
    }
  }
}

function normalizedRemoteAddress(address: string | undefined): string | null {
  if (!address) return null
  return address.startsWith('::ffff:')
    ? address.slice('::ffff:'.length)
    : address
}

function createPinnedConnector(
  approvedAddress: string,
  timeoutMs: number
): ReturnType<typeof buildConnector> {
  const connect = buildConnector({
    lookup: createPinnedLookup(approvedAddress),
    timeout: timeoutMs
  })

  return (options, callback): void => {
    connect(options, (error, socket) => {
      if (error || !socket) {
        callback(error ?? new EgressPolicyError('REQUEST_FAILED'), null)
        return
      }
      if (normalizedRemoteAddress(socket.remoteAddress) !== approvedAddress) {
        socket.destroy()
        callback(new EgressPolicyError('ADDRESS_BLOCKED'), null)
        return
      }
      callback(null, socket)
    })
  }
}

function findPolicyError(error: unknown): EgressPolicyError | null {
  let candidate = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate instanceof EgressPolicyError) return candidate
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('cause' in candidate)
    ) {
      return null
    }
    candidate = candidate.cause
  }
  return null
}

export class EgressPolicy {
  readonly #allowPrivateNetwork: boolean
  readonly #dnsLookup: DnsLookup
  readonly #dnsTimeoutMs: number
  readonly #maxRedirects: number
  readonly #requestTimeoutMs: number
  readonly #testOnlyAllowLoopback: boolean
  #activeRemoteTorrentFetches = 0

  constructor(options: EgressPolicyOptions = {}) {
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false
    this.#dnsLookup =
      options.dnsLookup ??
      (async hostname =>
        systemLookup(hostname, {
          all: true,
          family: 4,
          verbatim: true
        }))
    this.#dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#testOnlyAllowLoopback = options.testOnlyAllowLoopback ?? false
  }

  validateTrackerUrl(value: string): string {
    const url = parseNetworkUrl(value)
    if (url.protocol === 'udp:' || url.protocol === 'ws:') {
      throw new EgressPolicyError('TRACKER_TRANSPORT_DISABLED')
    }
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'wss:'
    ) {
      throw new EgressPolicyError('SCHEME_BLOCKED')
    }
    return url.href
  }

  validateWebSeedUrl(value: string): string {
    const url = parseNetworkUrl(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new EgressPolicyError('SCHEME_BLOCKED')
    }
    return url.href
  }

  validateRemoteTorrentUrl(
    value: string,
    options: RemoteTorrentUrlOptions
  ): string {
    const url = parseNetworkUrl(value)
    if (url.protocol === 'http:' && !options.allowHttp) {
      throw new EgressPolicyError('HTTP_DISABLED')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new EgressPolicyError('SCHEME_BLOCKED')
    }
    return url.href
  }

  validateRemoteTorrentRedirect(
    from: string,
    location: string,
    options: RemoteTorrentUrlOptions
  ): string {
    const current = new URL(this.validateRemoteTorrentUrl(from, options))
    let redirected: URL
    try {
      redirected = new URL(location, current)
    } catch {
      throw new EgressPolicyError('REDIRECT_BLOCKED')
    }
    const parsedRedirect = parseNetworkUrl(redirected)
    if (current.protocol === 'https:' && parsedRedirect.protocol === 'http:') {
      throw new EgressPolicyError('REDIRECT_BLOCKED')
    }
    return this.validateRemoteTorrentUrl(parsedRedirect.href, options)
  }

  async fetchRemoteTorrentBytes(
    value: string,
    options: RemoteTorrentUrlOptions
  ): Promise<RemoteTorrentFetchResult> {
    if (this.#activeRemoteTorrentFetches >= 2) {
      throw new EgressPolicyError('CONCURRENCY_LIMIT')
    }
    this.#activeRemoteTorrentFetches += 1
    const deadline = Date.now() + this.#requestTimeoutMs

    try {
      let current = new URL(this.validateRemoteTorrentUrl(value, options))
      let redirectCount = 0
      while (true) {
        const hop = await this.#fetchRemoteTorrentHop(
          current,
          deadline,
          options.signal
        )
        if (hop.kind === 'success') {
          return { bytes: hop.bytes, finalUrl: current.href }
        }
        if (redirectCount >= this.#maxRedirects) {
          throw new EgressPolicyError('REDIRECT_BLOCKED')
        }

        try {
          current = new URL(
            this.validateRemoteTorrentRedirect(
              current.href,
              hop.location,
              options
            )
          )
        } catch {
          throw new EgressPolicyError('REDIRECT_BLOCKED')
        }
        redirectCount += 1
      }
    } finally {
      this.#activeRemoteTorrentFetches -= 1
    }
  }

  async #fetchRemoteTorrentHop(
    url: URL,
    deadline: number,
    callerSignal: AbortSignal | undefined
  ): Promise<RemoteTorrentHop> {
    const approvedAddress = await this.#approvedAddress(url.hostname, deadline)
    const dispatcher = new UndiciAgent({
      connect: createPinnedConnector(
        approvedAddress,
        this.#remainingMilliseconds(deadline)
      )
    })
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      this.#remainingMilliseconds(deadline)
    )
    const abortFromCaller = (): void => controller.abort()
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort()
      else
        callerSignal.addEventListener('abort', abortFromCaller, { once: true })
    }

    try {
      const response = await undiciFetch(url, {
        dispatcher,
        headers: {
          accept: 'application/x-bittorrent, application/octet-stream;q=0.9',
          'accept-encoding': 'identity',
          'cache-control': 'no-store'
        },
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!REDIRECT_STATUSES.has(response.status) || !location) {
          throw new EgressPolicyError('REDIRECT_BLOCKED')
        }
        return { kind: 'redirect', location }
      }
      if (response.status !== 200) {
        await response.body?.cancel()
        throw new EgressPolicyError('HTTP_STATUS')
      }

      const contentEncoding = response.headers
        .get('content-encoding')
        ?.trim()
        .toLowerCase()
      if (contentEncoding && contentEncoding !== 'identity') {
        await response.body?.cancel()
        throw new EgressPolicyError('RESPONSE_ENCODING_BLOCKED')
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength !== null) {
        if (!/^\d+$/u.test(contentLength)) {
          await response.body?.cancel()
          throw new EgressPolicyError('REQUEST_FAILED')
        }
        if (Number(contentLength) > REMOTE_TORRENT_MAX_BYTES) {
          await response.body?.cancel()
          throw new EgressPolicyError('BODY_TOO_LARGE')
        }
      }

      const storage = new Uint8Array(REMOTE_TORRENT_MAX_BYTES)
      let chunkCount = 0
      let totalBytes = 0
      if (response.body) {
        for await (const rawChunk of response.body) {
          const chunk = toUint8Array(rawChunk)
          chunkCount += 1
          totalBytes += chunk.byteLength
          if (
            chunkCount > MAX_RESPONSE_CHUNKS ||
            totalBytes > REMOTE_TORRENT_MAX_BYTES
          ) {
            controller.abort()
            throw new EgressPolicyError('BODY_TOO_LARGE')
          }
          storage.set(chunk, totalBytes - chunk.byteLength)
        }
      }
      return {
        bytes: storage.subarray(0, totalBytes),
        kind: 'success'
      }
    } catch (error) {
      const policyError = findPolicyError(error)
      if (policyError) throw policyError
      if (controller.signal.aborted) {
        throw new EgressPolicyError(
          callerSignal?.aborted ? 'REQUEST_FAILED' : 'REQUEST_TIMEOUT'
        )
      }
      throw new EgressPolicyError(
        'REQUEST_FAILED',
        error instanceof Error
          ? `Network request failed: ${error.name}.`
          : undefined
      )
    } finally {
      clearTimeout(timeout)
      callerSignal?.removeEventListener('abort', abortFromCaller)
      await dispatcher.destroy().catch(() => undefined)
    }
  }

  async #approvedAddress(hostname: string, deadline: number): Promise<string> {
    const unwrappedHostname =
      hostname.startsWith('[') && hostname.endsWith(']')
        ? hostname.slice(1, -1)
        : hostname

    if (
      isLocalHostname(unwrappedHostname) &&
      !this.#allowPrivateNetwork &&
      !this.#testOnlyAllowLoopback
    ) {
      throw new EgressPolicyError('ADDRESS_BLOCKED')
    }

    if (isIP(unwrappedHostname) !== 0) {
      if (isIP(unwrappedHostname) !== 4) {
        throw new EgressPolicyError('ADDRESS_BLOCKED')
      }
      this.#assertAddressAllowed(unwrappedHostname)
      return unwrappedHostname
    }

    const remaining = this.#remainingMilliseconds(deadline)
    const dnsTimeout = Math.min(this.#dnsTimeoutMs, remaining)
    const timeoutCode =
      remaining <= this.#dnsTimeoutMs ? 'REQUEST_TIMEOUT' : 'DNS_TIMEOUT'
    let timeout: NodeJS.Timeout | null = null
    try {
      const records = await Promise.race([
        this.#dnsLookup(unwrappedHostname),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new EgressPolicyError(timeoutCode)),
            dnsTimeout
          )
        })
      ])
      if (records.length === 0 || records.length > MAX_DNS_ANSWERS) {
        throw new EgressPolicyError('DNS_FAILED')
      }

      const addresses = Array.from(
        new Set(
          records
            .filter(record => record.family === 4)
            .map(record => record.address)
        )
      )
      if (addresses.length === 0) {
        throw new EgressPolicyError('ADDRESS_BLOCKED')
      }
      for (const address of addresses) this.#assertAddressAllowed(address)
      return addresses[0] as string
    } catch (error) {
      if (error instanceof EgressPolicyError) throw error
      throw new EgressPolicyError('DNS_FAILED')
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  #assertAddressAllowed(address: string): void {
    const allowed =
      isPublicIpv4(address) ||
      (this.#allowPrivateNetwork && isPrivateNetworkIpv4(address)) ||
      (this.#testOnlyAllowLoopback && isLoopbackIpv4(address))
    if (!allowed) throw new EgressPolicyError('ADDRESS_BLOCKED')
  }

  #remainingMilliseconds(deadline: number): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new EgressPolicyError('REQUEST_TIMEOUT')
    return remaining
  }
}
