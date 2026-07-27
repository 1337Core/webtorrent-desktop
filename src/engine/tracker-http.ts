import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { EgressPolicyError, type EgressPolicy } from './network-policy'
import { PeerAdmissionPolicy } from './peer-admission'
import { TRACKER_HTTP_EGRESS_PROFILE } from './tracker-http-profile'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export { TRACKER_HTTP_EGRESS_PROFILE } from './tracker-http-profile'

const MAX_BENCODE_DEPTH = 8
const MAX_BENCODE_VALUES = 1_024
const MAX_COLLECTION_ENTRIES = 256
const MAX_DICTIONARY_KEY_BYTES = 64
const MAX_INTEGER_DIGITS = 16
const MAX_MESSAGE_BYTES = 512
const MAX_TRACKER_ID_BYTES = 128

const ASCII_COLON = 0x3a
const ASCII_DICTIONARY = 0x64
const ASCII_END = 0x65
const ASCII_INTEGER = 0x69
const ASCII_LIST = 0x6c
const ASCII_MINUS = 0x2d
const ASCII_ZERO = 0x30
const ASCII_NINE = 0x39

export type TrackerHttpErrorCode =
  | 'ABORTED'
  | 'BODY_TOO_LARGE'
  | 'CONCURRENCY_LIMIT'
  | 'HTTP_DISABLED'
  | 'INVALID_REQUEST'
  | 'INVALID_RESPONSE'
  | 'NETWORK_FAILED'
  | 'PEER_LIMIT'
  | 'TIMEOUT'
  | 'TRACKER_FAILURE'
  | 'TRANSPORT_DISABLED'

export class TrackerHttpError extends Error {
  readonly code: TrackerHttpErrorCode

  constructor(code: TrackerHttpErrorCode) {
    super(`Tracker HTTP announce failed: ${code}.`)
    this.name = 'TrackerHttpError'
    this.code = code
  }
}

type TrackerAnnounceEvent = 'completed' | 'started' | 'stopped'

export type TrackerAnnounceInput = Readonly<{
  allowHttp: boolean
  allowPrivateNetwork: boolean
  downloaded: number
  event?: TrackerAnnounceEvent
  infoHash: Uint8Array
  left: number
  peerId: Uint8Array
  port: number
  signal?: AbortSignal
  trackerId?: Uint8Array
  trackerUrl: string
  uploaded: number
}>

type TrackerPeer = Readonly<{
  address: string
  family: 4
  peerId?: Uint8Array
  port: number
}>

export type TrackerAnnounceResponse = Readonly<{
  complete: number | null
  incomplete: number | null
  interval: number
  minInterval: number | null
  peers: ReadonlyArray<TrackerPeer>
  trackerId: Uint8Array | null
  warningMessage: string | null
}>

type TrackerHttpFetchOptions = Readonly<{
  allowHttp: boolean
  signal: AbortSignal
}>

export type TrackerHttpFetchResult = Readonly<{
  bytes: Uint8Array
}>

/**
 * This is deliberately narrower than a general HTTP client. Its implementation
 * owns the fixed headers, three-redirect limit, one-MiB streaming body limit,
 * DNS pinning, address checks, and redirect revalidation described by
 * TRACKER_HTTP_EGRESS_PROFILE.
 */
export type TrackerHttpEgress = Pick<EgressPolicy, 'validateTrackerUrl'> &
  Readonly<{
    fetchTrackerResponse(
      value: string,
      options: TrackerHttpFetchOptions
    ): Promise<TrackerHttpFetchResult>
  }>

export class TrackerHttpRequestGate {
  readonly #maximum: number
  #active = 0

  constructor(maximum: number = TRACKER_HTTP_EGRESS_PROFILE.globalConcurrency) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error('Invalid shared tracker HTTP concurrency limit')
    }
    this.#maximum = maximum
  }

  get active(): number {
    return this.#active
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#maximum) {
      throw new TrackerHttpError('CONCURRENCY_LIMIT')
    }
    this.#active += 1
    try {
      return await operation()
    } finally {
      this.#active -= 1
    }
  }
}

export type TrackerHttpTransportOptions = Readonly<{
  egress: TrackerHttpEgress
  now?: () => number
  requestGate: TrackerHttpRequestGate
}>

export class TrackerHttpTransport {
  readonly #egress: TrackerHttpEgress
  readonly #now: () => number
  readonly #requestGate: TrackerHttpRequestGate

  constructor(options: TrackerHttpTransportOptions) {
    this.#egress = options.egress
    this.#now = options.now ?? (() => performance.now())
    this.#requestGate = options.requestGate
  }

  async announce(
    input: TrackerAnnounceInput
  ): Promise<TrackerAnnounceResponse> {
    const announceUrl = buildTrackerAnnounceUrl(this.#egress, input)
    const peerAdmission = new PeerAdmissionPolicy({
      allowPrivateNetwork: input.allowPrivateNetwork,
      localPeerId: input.peerId
    })
    if (input.signal?.aborted) throw new TrackerHttpError('ABORTED')

    const controller = new AbortController()
    const deadline =
      this.#now() + TRACKER_HTTP_EGRESS_PROFILE.absoluteDeadlineMs
    let abortKind: 'caller' | 'deadline' | null = null
    const abortFromCaller = (): void => {
      abortKind = 'caller'
      controller.abort()
    }
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })

    const timeout = setTimeout(() => {
      abortKind = 'deadline'
      controller.abort()
    }, TRACKER_HTTP_EGRESS_PROFILE.absoluteDeadlineMs)
    timeout.unref()

    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            new TrackerHttpError(abortKind === 'caller' ? 'ABORTED' : 'TIMEOUT')
          ),
        { once: true }
      )
    })
    const fetchOperation = this.#requestGate.run(() =>
      this.#egress.fetchTrackerResponse(announceUrl, {
        allowHttp: input.allowHttp,
        signal: controller.signal
      })
    )

    try {
      const result = await Promise.race([fetchOperation, aborted])
      if (controller.signal.aborted || this.#now() >= deadline) {
        throw new TrackerHttpError(
          abortKind === 'caller' ? 'ABORTED' : 'TIMEOUT'
        )
      }
      if (
        !(result.bytes instanceof Uint8Array) ||
        result.bytes.byteLength > TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes
      ) {
        throw new TrackerHttpError('BODY_TOO_LARGE')
      }
      const response = parseTrackerAnnounceResponse(result.bytes, peerAdmission)
      if (this.#now() >= deadline) throw new TrackerHttpError('TIMEOUT')
      return response
    } catch (error) {
      if (error instanceof TrackerHttpError) throw error
      if (abortKind === 'caller') throw new TrackerHttpError('ABORTED')
      if (abortKind === 'deadline') throw new TrackerHttpError('TIMEOUT')
      if (error instanceof EgressPolicyError) {
        throw new TrackerHttpError(mapEgressPolicyError(error))
      }
      throw new TrackerHttpError('NETWORK_FAILED')
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function mapEgressPolicyError(
  error: EgressPolicyError
): Extract<
  TrackerHttpErrorCode,
  | 'ABORTED'
  | 'BODY_TOO_LARGE'
  | 'CONCURRENCY_LIMIT'
  | 'HTTP_DISABLED'
  | 'NETWORK_FAILED'
  | 'TIMEOUT'
> {
  switch (error.code) {
    case 'ABORTED':
      return 'ABORTED'
    case 'BODY_TOO_LARGE':
      return 'BODY_TOO_LARGE'
    case 'CONCURRENCY_LIMIT':
      return 'CONCURRENCY_LIMIT'
    case 'HTTP_DISABLED':
      return 'HTTP_DISABLED'
    case 'REQUEST_TIMEOUT':
      return 'TIMEOUT'
    default:
      return 'NETWORK_FAILED'
  }
}

function buildTrackerAnnounceUrl(
  policy: Pick<EgressPolicy, 'validateTrackerUrl'>,
  input: TrackerAnnounceInput
): string {
  validateAnnounceInput(input)

  let parsed: URL
  try {
    parsed = new URL(input.trackerUrl)
  } catch {
    throw new TrackerHttpError('INVALID_REQUEST')
  }

  if (parsed.protocol === 'http:' && !input.allowHttp) {
    throw new TrackerHttpError('HTTP_DISABLED')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TrackerHttpError('TRANSPORT_DISABLED')
  }

  try {
    parsed = new URL(policy.validateTrackerUrl(input.trackerUrl))
  } catch {
    throw new TrackerHttpError('INVALID_REQUEST')
  }

  const reservedParameters = new Set([
    'compact',
    'downloaded',
    'event',
    'info_hash',
    'left',
    'no_peer_id',
    'numwant',
    'peer_id',
    'port',
    'trackerid',
    'uploaded'
  ])
  for (const key of parsed.searchParams.keys()) {
    if (reservedParameters.has(key)) {
      throw new TrackerHttpError('INVALID_REQUEST')
    }
  }

  const fields = [
    `info_hash=${percentEncodeBytes(input.infoHash)}`,
    `peer_id=${percentEncodeBytes(input.peerId)}`,
    `port=${input.port}`,
    `uploaded=${input.uploaded}`,
    `downloaded=${input.downloaded}`,
    `left=${input.left}`,
    'compact=1',
    'no_peer_id=1',
    `numwant=${TRACKER_HTTP_EGRESS_PROFILE.requestedPeers}`
  ]
  if (input.event) fields.push(`event=${input.event}`)
  if (input.trackerId) {
    fields.push(`trackerid=${percentEncodeBytes(input.trackerId)}`)
  }

  const existingQuery = parsed.search.slice(1)
  parsed.search = existingQuery
    ? `${existingQuery}&${fields.join('&')}`
    : fields.join('&')
  return parsed.href
}

function validateAnnounceInput(input: TrackerAnnounceInput): void {
  if (
    !(input.infoHash instanceof Uint8Array) ||
    input.infoHash.byteLength !== 20 ||
    !(input.peerId instanceof Uint8Array) ||
    input.peerId.byteLength !== 20 ||
    typeof input.allowHttp !== 'boolean' ||
    typeof input.allowPrivateNetwork !== 'boolean' ||
    !isNonNegativeSafeInteger(input.uploaded) ||
    !isNonNegativeSafeInteger(input.downloaded) ||
    !isNonNegativeSafeInteger(input.left) ||
    !Number.isSafeInteger(input.port) ||
    input.port < 1 ||
    input.port > 65_535 ||
    (input.event !== undefined &&
      input.event !== 'completed' &&
      input.event !== 'started' &&
      input.event !== 'stopped') ||
    (input.trackerId !== undefined &&
      (!(input.trackerId instanceof Uint8Array) ||
        input.trackerId.byteLength < 1 ||
        input.trackerId.byteLength > MAX_TRACKER_ID_BYTES))
  ) {
    throw new TrackerHttpError('INVALID_REQUEST')
  }
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function percentEncodeBytes(bytes: Uint8Array): string {
  let encoded = ''
  for (const byte of bytes) {
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

type BencodeValue =
  number | Uint8Array | BencodeValue[] | Map<string, BencodeValue>

class TrackerBencodeDecoder {
  readonly #bytes: Uint8Array
  #index = 0
  #valueCount = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  decode(): Map<string, BencodeValue> {
    if (
      this.#bytes.byteLength === 0 ||
      this.#bytes.byteLength > TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes
    ) {
      throw new TrackerHttpError(
        this.#bytes.byteLength > TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes
          ? 'BODY_TOO_LARGE'
          : 'INVALID_RESPONSE'
      )
    }
    const value = this.#parseValue(0)
    if (!(value instanceof Map) || this.#index !== this.#bytes.byteLength) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    return value
  }

  #parseValue(depth: number): BencodeValue {
    if (depth > MAX_BENCODE_DEPTH) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    this.#valueCount += 1
    if (this.#valueCount > MAX_BENCODE_VALUES) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }

    const token = this.#bytes[this.#index]
    if (token === ASCII_DICTIONARY) return this.#parseDictionary(depth)
    if (token === ASCII_LIST) return this.#parseList(depth)
    if (token === ASCII_INTEGER) return this.#parseInteger()
    if (token !== undefined && token >= ASCII_ZERO && token <= ASCII_NINE) {
      return this.#parseByteString()
    }
    throw new TrackerHttpError('INVALID_RESPONSE')
  }

  #parseDictionary(depth: number): Map<string, BencodeValue> {
    this.#index += 1
    const result = new Map<string, BencodeValue>()
    let previousKey: Uint8Array | null = null
    let entries = 0

    while (this.#bytes[this.#index] !== ASCII_END) {
      if (this.#index >= this.#bytes.byteLength) {
        throw new TrackerHttpError('INVALID_RESPONSE')
      }
      entries += 1
      if (entries > MAX_COLLECTION_ENTRIES) {
        throw new TrackerHttpError('INVALID_RESPONSE')
      }

      const keyBytes = this.#parseByteString()
      if (
        keyBytes.byteLength === 0 ||
        keyBytes.byteLength > MAX_DICTIONARY_KEY_BYTES ||
        !keyBytes.every(byte => byte >= 0x20 && byte <= 0x7e)
      ) {
        throw new TrackerHttpError('INVALID_RESPONSE')
      }
      if (previousKey && compareBytes(previousKey, keyBytes) >= 0) {
        throw new TrackerHttpError('INVALID_RESPONSE')
      }
      previousKey = keyBytes

      const key = decodeUtf8(keyBytes)
      result.set(key, this.#parseValue(depth + 1))
    }
    this.#index += 1
    return result
  }

  #parseList(depth: number): BencodeValue[] {
    this.#index += 1
    const result: BencodeValue[] = []
    while (this.#bytes[this.#index] !== ASCII_END) {
      if (
        this.#index >= this.#bytes.byteLength ||
        result.length >= MAX_COLLECTION_ENTRIES
      ) {
        throw new TrackerHttpError('INVALID_RESPONSE')
      }
      result.push(this.#parseValue(depth + 1))
    }
    this.#index += 1
    return result
  }

  #parseInteger(): number {
    this.#index += 1
    const start = this.#index
    if (this.#bytes[this.#index] === ASCII_MINUS) this.#index += 1
    const digitStart = this.#index
    while (
      (this.#bytes[this.#index] ?? -1) >= ASCII_ZERO &&
      (this.#bytes[this.#index] ?? -1) <= ASCII_NINE
    ) {
      this.#index += 1
    }
    const digitCount = this.#index - digitStart
    if (
      digitCount < 1 ||
      digitCount > MAX_INTEGER_DIGITS ||
      this.#bytes[this.#index] !== ASCII_END ||
      (digitCount > 1 && this.#bytes[digitStart] === ASCII_ZERO) ||
      (this.#bytes[start] === ASCII_MINUS &&
        digitCount === 1 &&
        this.#bytes[digitStart] === ASCII_ZERO)
    ) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }

    const value = Number(decodeUtf8(this.#bytes.subarray(start, this.#index)))
    if (!Number.isSafeInteger(value)) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    this.#index += 1
    return value
  }

  #parseByteString(): Uint8Array {
    const lengthStart = this.#index
    while (
      (this.#bytes[this.#index] ?? -1) >= ASCII_ZERO &&
      (this.#bytes[this.#index] ?? -1) <= ASCII_NINE
    ) {
      this.#index += 1
    }
    if (
      lengthStart === this.#index ||
      this.#bytes[this.#index] !== ASCII_COLON
    ) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }

    const lengthBytes = this.#bytes.subarray(lengthStart, this.#index)
    if (
      lengthBytes.byteLength > 7 ||
      (lengthBytes.byteLength > 1 && lengthBytes[0] === ASCII_ZERO)
    ) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    const length = Number(decodeUtf8(lengthBytes))
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes
    ) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }

    this.#index += 1
    const end = this.#index + length
    if (end > this.#bytes.byteLength) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    const value = this.#bytes.subarray(this.#index, end)
    this.#index = end
    return value
  }
}

export function parseTrackerAnnounceResponse(
  bytes: Uint8Array,
  peerAdmission: PeerAdmissionPolicy
): TrackerAnnounceResponse {
  const dictionary = new TrackerBencodeDecoder(bytes).decode()
  const failureReason = dictionary.get('failure reason')
  if (failureReason !== undefined) {
    decodeBoundedMessage(failureReason, false)
    throw new TrackerHttpError('TRACKER_FAILURE')
  }

  const interval = normalizedAnnounceInterval(
    requiredBoundedInteger(dictionary.get('interval'), 1, 2_147_483_647)
  )
  const rawMinInterval = optionalBoundedInteger(
    dictionary.get('min interval'),
    1,
    2_147_483_647
  )
  const minInterval =
    rawMinInterval === null ? null : normalizedAnnounceInterval(rawMinInterval)
  const complete = optionalBoundedInteger(
    dictionary.get('complete'),
    0,
    2_147_483_647
  )
  const incomplete = optionalBoundedInteger(
    dictionary.get('incomplete'),
    0,
    2_147_483_647
  )
  const warningMessage = dictionary.has('warning message')
    ? decodeBoundedMessage(dictionary.get('warning message'), true)
    : null
  const trackerId = dictionary.has('tracker id')
    ? boundedByteString(dictionary.get('tracker id'), 1, MAX_TRACKER_ID_BYTES)
    : null

  const peers: TrackerPeer[] = []
  const peersValue = dictionary.get('peers')
  if (peersValue instanceof Uint8Array) {
    appendCompactIpv4Peers(peersValue, peers)
  } else if (Array.isArray(peersValue)) {
    appendDictionaryPeers(peersValue, peers)
  } else if (peersValue !== undefined) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }

  const peers6Value = dictionary.get('peers6')
  if (peers6Value instanceof Uint8Array) {
    validateIgnoredCompactIpv6Peers(peers6Value, peers.length)
  } else if (peers6Value !== undefined) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }

  const uniquePeers = new Map<string, TrackerPeer>()
  for (const peer of peers) {
    const key = `${peer.family}|${peer.address}|${peer.port}`
    if (!uniquePeers.has(key)) uniquePeers.set(key, peer)
  }

  return {
    complete,
    incomplete,
    interval,
    minInterval,
    peers: [...uniquePeers.values()].filter(peer => peerAdmission.allows(peer)),
    trackerId: trackerId?.slice() ?? null,
    warningMessage
  }
}

function appendCompactIpv4Peers(bytes: Uint8Array, peers: TrackerPeer[]): void {
  if (bytes.byteLength % 6 !== 0) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
  reservePeerCount(peers.length, bytes.byteLength / 6)
  for (let offset = 0; offset < bytes.byteLength; offset += 6) {
    const port = readPort(bytes, offset + 4)
    peers.push({
      address: `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`,
      family: 4,
      port
    })
  }
}

function validateIgnoredCompactIpv6Peers(
  bytes: Uint8Array,
  currentPeerCount: number
): void {
  if (bytes.byteLength % 18 !== 0) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
  reservePeerCount(currentPeerCount, bytes.byteLength / 18)
  for (let offset = 0; offset < bytes.byteLength; offset += 18) {
    readPort(bytes, offset + 16)
  }
}

function appendDictionaryPeers(
  values: BencodeValue[],
  peers: TrackerPeer[]
): void {
  reservePeerCount(peers.length, values.length)
  for (const value of values) {
    if (!(value instanceof Map)) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    const addressBytes = boundedByteString(value.get('ip'), 1, 45)
    const address = decodeUtf8(addressBytes)
    if (
      address.includes('%') ||
      hasUnsafeDisplayCharacters(address) ||
      (isIP(address) !== 4 && isIP(address) !== 6)
    ) {
      throw new TrackerHttpError('INVALID_RESPONSE')
    }
    const port = requiredBoundedInteger(value.get('port'), 1, 65_535)
    const peerIdValue = value.get('peer id')
    const peerId =
      peerIdValue === undefined
        ? undefined
        : boundedByteString(peerIdValue, 20, 20).slice()
    const family = isIP(address)
    if (family === 6) continue
    peers.push({
      address,
      family: 4,
      ...(peerId ? { peerId } : {}),
      port
    })
  }
}

function reservePeerCount(current: number, additional: number): void {
  if (
    additional < 0 ||
    current + additional > TRACKER_HTTP_EGRESS_PROFILE.maxAcceptedPeers
  ) {
    throw new TrackerHttpError('PEER_LIMIT')
  }
}

function readPort(bytes: Uint8Array, offset: number): number {
  const port = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
  if (port < 1) throw new TrackerHttpError('INVALID_RESPONSE')
  return port
}

function normalizedAnnounceInterval(value: number): number {
  return Math.min(
    TRACKER_HTTP_EGRESS_PROFILE.maxAnnounceIntervalSeconds,
    Math.max(TRACKER_HTTP_EGRESS_PROFILE.minAnnounceIntervalSeconds, value)
  )
}

function requiredBoundedInteger(
  value: BencodeValue | undefined,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
  return value
}

function optionalBoundedInteger(
  value: BencodeValue | undefined,
  minimum: number,
  maximum: number
): number | null {
  return value === undefined
    ? null
    : requiredBoundedInteger(value, minimum, maximum)
}

function boundedByteString(
  value: BencodeValue | undefined,
  minimumBytes: number,
  maximumBytes: number
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimumBytes ||
    value.byteLength > maximumBytes
  ) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
  return value
}

function decodeBoundedMessage(
  value: BencodeValue | undefined,
  allowEmpty: boolean
): string {
  const bytes = boundedByteString(value, allowEmpty ? 0 : 1, MAX_MESSAGE_BYTES)
  const message = decodeUtf8(bytes)
  if (hasUnsafeDisplayCharacters(message)) {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
  return message
}

function hasUnsafeDisplayCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true
    }
  }
  return false
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes)
  } catch {
    throw new TrackerHttpError('INVALID_RESPONSE')
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}
