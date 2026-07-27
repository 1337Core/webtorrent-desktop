import { randomBytes } from 'node:crypto'
import { isPublicIpv4 } from './network-policy'

export const DHT_WIRE_LIMITS = Object.freeze({
  bucketRefillPerSecond: 256,
  compactNodeBytes: 26,
  compactPeerBytes: 6,
  globalBurst: 512,
  maxDatagramBytes: 2_048,
  maxDepth: 8,
  maxErrorMessageBytes: 256,
  maxOutboundNodes: 20,
  maxOutboundPeerValues: 50,
  maxSanitizedNodes: 20,
  maxSourceEntries: 1_024,
  maxStringBytes: 1_024,
  maxTokenBytes: 64,
  maxTransactionBytes: 20,
  maxValues: 256,
  sourceBurst: 32,
  sourceExpiryMs: 5 * 60_000,
  sourceRefillPerSecond: 16
})

export type DhtWireErrorCode =
  | 'DATAGRAM_TOO_LARGE'
  | 'DEPTH_LIMIT'
  | 'DICTIONARY_ORDER'
  | 'DUPLICATE_KEY'
  | 'INVALID_ENVELOPE'
  | 'INVALID_TOKEN'
  | 'METHOD_NOT_ALLOWED'
  | 'STRING_LIMIT'
  | 'TRAILING_DATA'
  | 'TRUNCATED'
  | 'VALUE_LIMIT'

export class DhtWireError extends Error {
  readonly code: DhtWireErrorCode

  constructor(code: DhtWireErrorCode) {
    super(`DHT datagram was rejected: ${code}.`)
    this.name = 'DhtWireError'
    this.code = code
  }
}

type KrpcQueryMethod = 'announce_peer' | 'find_node' | 'get_peers' | 'ping'

const ALLOWED_METHODS = new Set<string>([
  'announce_peer',
  'find_node',
  'get_peers',
  'ping'
])

export type KrpcValue =
  Uint8Array | number | KrpcValue[] | Map<string, KrpcValue>

export type KrpcMessage =
  | Readonly<{
      arguments: Map<string, KrpcValue>
      kind: 'query'
      method: KrpcQueryMethod
      transactionId: Uint8Array
    }>
  | Readonly<{
      kind: 'response'
      response: Map<string, KrpcValue>
      transactionId: Uint8Array
    }>
  | Readonly<{
      code: number
      kind: 'error'
      transactionId: Uint8Array
    }>

const ASCII_COLON = 0x3a
const ASCII_DICTIONARY = 0x64
const ASCII_END = 0x65
const ASCII_INTEGER = 0x69
const ASCII_LIST = 0x6c
const ASCII_MINUS = 0x2d
const ASCII_ZERO = 0x30
const ASCII_NINE = 0x39
const NODE_ID_BYTES = 20

/**
 * A bounded bencode reader for DHT datagrams.
 *
 * Every limit is applied before allocation so a hostile peer cannot make the
 * engine build a large structure, and dictionary keys must already be sorted
 * and unique so two encodings of one message cannot disagree.
 */
class DhtBencodeDecoder {
  readonly #bytes: Uint8Array
  #offset = 0
  #values = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  decode(): Map<string, KrpcValue> {
    const value = this.#readValue(0)
    if (this.#offset !== this.#bytes.byteLength) {
      throw new DhtWireError('TRAILING_DATA')
    }
    if (!(value instanceof Map)) throw new DhtWireError('INVALID_ENVELOPE')
    return value
  }

  #readValue(depth: number): KrpcValue {
    if (depth > DHT_WIRE_LIMITS.maxDepth) throw new DhtWireError('DEPTH_LIMIT')
    this.#values += 1
    if (this.#values > DHT_WIRE_LIMITS.maxValues) {
      throw new DhtWireError('VALUE_LIMIT')
    }

    const token = this.#peek()
    if (token === ASCII_DICTIONARY) return this.#readDictionary(depth)
    if (token === ASCII_LIST) return this.#readList(depth)
    if (token === ASCII_INTEGER) return this.#readInteger()
    return this.#readString()
  }

  #readDictionary(depth: number): Map<string, KrpcValue> {
    this.#expect(ASCII_DICTIONARY)
    const entries = new Map<string, KrpcValue>()
    let previous: Uint8Array | null = null
    while (this.#peek() !== ASCII_END) {
      const key = this.#readString()
      if (previous && compareBytes(previous, key) >= 0) {
        throw new DhtWireError(
          compareBytes(previous, key) === 0
            ? 'DUPLICATE_KEY'
            : 'DICTIONARY_ORDER'
        )
      }
      previous = key
      entries.set(latin1(key), this.#readValue(depth + 1))
    }
    this.#expect(ASCII_END)
    return entries
  }

  #readList(depth: number): KrpcValue[] {
    this.#expect(ASCII_LIST)
    const items: KrpcValue[] = []
    while (this.#peek() !== ASCII_END) items.push(this.#readValue(depth + 1))
    this.#expect(ASCII_END)
    return items
  }

  #readInteger(): number {
    this.#expect(ASCII_INTEGER)
    const start = this.#offset
    if (this.#peek() === ASCII_MINUS) this.#offset += 1
    let digits = 0
    while (this.#peek() >= ASCII_ZERO && this.#peek() <= ASCII_NINE) {
      this.#offset += 1
      digits += 1
      if (digits > 16) throw new DhtWireError('VALUE_LIMIT')
    }
    if (digits === 0) throw new DhtWireError('INVALID_ENVELOPE')
    const text = latin1(this.#bytes.subarray(start, this.#offset))
    this.#expect(ASCII_END)
    if (!/^-?(?:0|[1-9]\d*)$/u.test(text)) {
      throw new DhtWireError('INVALID_ENVELOPE')
    }
    const value = Number(text)
    if (!Number.isSafeInteger(value)) throw new DhtWireError('VALUE_LIMIT')
    return value
  }

  #readString(): Uint8Array {
    const start = this.#offset
    let digits = 0
    while (this.#peek() >= ASCII_ZERO && this.#peek() <= ASCII_NINE) {
      this.#offset += 1
      digits += 1
      if (digits > 5) throw new DhtWireError('STRING_LIMIT')
    }
    if (digits === 0) throw new DhtWireError('INVALID_ENVELOPE')
    const length = Number(latin1(this.#bytes.subarray(start, this.#offset)))
    this.#expect(ASCII_COLON)
    if (length > DHT_WIRE_LIMITS.maxStringBytes) {
      throw new DhtWireError('STRING_LIMIT')
    }
    if (this.#offset + length > this.#bytes.byteLength) {
      throw new DhtWireError('TRUNCATED')
    }
    const value = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  #peek(): number {
    if (this.#offset >= this.#bytes.byteLength) {
      throw new DhtWireError('TRUNCATED')
    }
    return this.#bytes[this.#offset] as number
  }

  #expect(token: number): void {
    if (this.#peek() !== token) throw new DhtWireError('INVALID_ENVELOPE')
    this.#offset += 1
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number)
    if (difference !== 0) return difference
  }
  return left.byteLength - right.byteLength
}

function latin1(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return value
}

function requireBytes(
  value: KrpcValue | undefined,
  exactLength: number
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== exactLength) {
    throw new DhtWireError('INVALID_ENVELOPE')
  }
  return value
}

/**
 * Validates a datagram before any stock DHT code sees it. BEP 44 `get`/`put`
 * and every other unknown method are rejected outright.
 */
export function decodeDhtDatagram(bytes: Uint8Array): KrpcMessage {
  if (!(bytes instanceof Uint8Array)) throw new DhtWireError('INVALID_ENVELOPE')
  if (bytes.byteLength > DHT_WIRE_LIMITS.maxDatagramBytes) {
    throw new DhtWireError('DATAGRAM_TOO_LARGE')
  }

  const message = new DhtBencodeDecoder(bytes).decode()
  const transactionId = message.get('t')
  if (
    !(transactionId instanceof Uint8Array) ||
    transactionId.byteLength < 1 ||
    transactionId.byteLength > DHT_WIRE_LIMITS.maxTransactionBytes
  ) {
    throw new DhtWireError('INVALID_ENVELOPE')
  }

  const kind = message.get('y')
  if (!(kind instanceof Uint8Array) || kind.byteLength !== 1) {
    throw new DhtWireError('INVALID_ENVELOPE')
  }

  switch (latin1(kind)) {
    case 'q': {
      const method = message.get('q')
      if (!(method instanceof Uint8Array)) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      const name = latin1(method)
      if (!ALLOWED_METHODS.has(name)) {
        throw new DhtWireError('METHOD_NOT_ALLOWED')
      }
      const argumentsValue = message.get('a')
      if (!(argumentsValue instanceof Map)) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      requireBytes(argumentsValue.get('id'), NODE_ID_BYTES)
      if (name === 'find_node') {
        requireBytes(argumentsValue.get('target'), NODE_ID_BYTES)
      }
      if (name === 'get_peers' || name === 'announce_peer') {
        requireBytes(argumentsValue.get('info_hash'), NODE_ID_BYTES)
      }
      if (name === 'announce_peer') {
        const token = argumentsValue.get('token')
        if (
          !(token instanceof Uint8Array) ||
          token.byteLength < 1 ||
          token.byteLength > DHT_WIRE_LIMITS.maxTokenBytes
        ) {
          throw new DhtWireError('INVALID_TOKEN')
        }
        const port = argumentsValue.get('port')
        if (
          typeof port !== 'number' ||
          !Number.isSafeInteger(port) ||
          port < 1 ||
          port > 65_535
        ) {
          throw new DhtWireError('INVALID_ENVELOPE')
        }
      }
      return {
        arguments: argumentsValue,
        kind: 'query',
        method: name as KrpcQueryMethod,
        transactionId
      }
    }
    case 'r': {
      const response = message.get('r')
      if (!(response instanceof Map)) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      requireBytes(response.get('id'), NODE_ID_BYTES)

      const nodes = response.get('nodes')
      if (
        nodes !== undefined &&
        (!(nodes instanceof Uint8Array) ||
          nodes.byteLength % DHT_WIRE_LIMITS.compactNodeBytes !== 0)
      ) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      const values = response.get('values')
      if (values !== undefined) {
        if (!Array.isArray(values)) throw new DhtWireError('INVALID_ENVELOPE')
        for (const value of values) {
          if (
            !(value instanceof Uint8Array) ||
            value.byteLength !== DHT_WIRE_LIMITS.compactPeerBytes
          ) {
            throw new DhtWireError('INVALID_ENVELOPE')
          }
        }
      }

      // IPv6 answers are structurally validated, counted, and then dropped:
      // the first release is IPv4 only.
      const nodes6 = response.get('nodes6')
      if (
        nodes6 !== undefined &&
        (!(nodes6 instanceof Uint8Array) || nodes6.byteLength % 38 !== 0)
      ) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      response.delete('nodes6')
      const values6 = response.get('values6')
      if (values6 !== undefined) {
        if (!Array.isArray(values6)) throw new DhtWireError('INVALID_ENVELOPE')
        for (const value of values6) {
          if (!(value instanceof Uint8Array) || value.byteLength !== 18) {
            throw new DhtWireError('INVALID_ENVELOPE')
          }
        }
      }
      response.delete('values6')

      const token = response.get('token')
      if (
        token !== undefined &&
        (!(token instanceof Uint8Array) ||
          token.byteLength < 1 ||
          token.byteLength > DHT_WIRE_LIMITS.maxTokenBytes)
      ) {
        throw new DhtWireError('INVALID_TOKEN')
      }

      return { kind: 'response', response, transactionId }
    }
    case 'e': {
      const error = message.get('e')
      if (!Array.isArray(error) || error.length !== 2) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      const [code, text] = error
      if (typeof code !== 'number' || !Number.isSafeInteger(code)) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      if (
        !(text instanceof Uint8Array) ||
        text.byteLength > DHT_WIRE_LIMITS.maxErrorMessageBytes
      ) {
        throw new DhtWireError('INVALID_ENVELOPE')
      }
      return { code, kind: 'error', transactionId }
    }
    default:
      throw new DhtWireError('INVALID_ENVELOPE')
  }
}

export type CompactNode = Readonly<{
  address: string
  id: Uint8Array
  port: number
}>

/**
 * Keeps at most 20 public IPv4 contacts. A private, reserved, or zero-port
 * entry never reaches the routing table, in either direction.
 */
export function sanitizeCompactNodes(
  bytes: Uint8Array | undefined
): ReadonlyArray<CompactNode> {
  if (!bytes) return []
  const nodes: CompactNode[] = []
  for (
    let offset = 0;
    offset + DHT_WIRE_LIMITS.compactNodeBytes <= bytes.byteLength;
    offset += DHT_WIRE_LIMITS.compactNodeBytes
  ) {
    if (nodes.length >= DHT_WIRE_LIMITS.maxSanitizedNodes) break
    const id = bytes.subarray(offset, offset + NODE_ID_BYTES)
    const address = `${bytes[offset + 20]}.${bytes[offset + 21]}.${bytes[offset + 22]}.${bytes[offset + 23]}`
    const port =
      ((bytes[offset + 24] as number) << 8) | (bytes[offset + 25] as number)
    if (port < 1 || port > 65_535 || !isPublicIpv4(address)) continue
    nodes.push({ address, id: id.slice(), port })
  }
  return nodes
}

export type CompactPeer = Readonly<{ address: string; port: number }>

export function sanitizeCompactPeers(
  values: ReadonlyArray<KrpcValue> | undefined,
  maximum: number
): ReadonlyArray<CompactPeer> {
  if (!values) return []
  const peers: CompactPeer[] = []
  for (const value of values) {
    if (peers.length >= maximum) break
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength !== DHT_WIRE_LIMITS.compactPeerBytes
    ) {
      continue
    }
    const address = `${value[0]}.${value[1]}.${value[2]}.${value[3]}`
    const port = ((value[4] as number) << 8) | (value[5] as number)
    if (port < 1 || port > 65_535 || !isPublicIpv4(address)) continue
    peers.push({ address, port })
  }
  return peers
}

/**
 * Randomized, never-reused 16-bit transaction identifiers.
 *
 * `k-rpc-socket` issues sequential identifiers and matches responses on host
 * alone, which lets an off-path source answer a query it never received. The
 * boundary owns identity instead.
 */
export class DhtTransactionIds {
  readonly #active = new Set<number>()
  readonly #random: () => Uint8Array

  constructor(random: () => Uint8Array = () => randomBytes(2)) {
    this.#random = random
  }

  get size(): number {
    return this.#active.size
  }

  allocate(): number {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const bytes = this.#random()
      const candidate = (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) & 0xff_ff
      if (!this.#active.has(candidate)) {
        this.#active.add(candidate)
        return candidate
      }
    }
    for (let candidate = 0; candidate <= 0xff_ff; candidate += 1) {
      if (!this.#active.has(candidate)) {
        this.#active.add(candidate)
        return candidate
      }
    }
    throw new DhtWireError('VALUE_LIMIT')
  }

  release(id: number): boolean {
    return this.#active.delete(id)
  }

  has(id: number): boolean {
    return this.#active.has(id)
  }
}

type Bucket = { tokens: number; updatedAtMs: number }

/**
 * Token buckets for ingress: one global and one per source address, with a
 * bounded LRU so a spray of sources cannot grow memory.
 */
export class DhtIngressLimiter {
  readonly #now: () => number
  readonly #sources = new Map<string, Bucket>()
  #global: Bucket

  constructor(now: () => number = () => Date.now()) {
    this.#now = now
    this.#global = { tokens: DHT_WIRE_LIMITS.globalBurst, updatedAtMs: now() }
  }

  get trackedSources(): number {
    return this.#sources.size
  }

  accept(source: string): boolean {
    const now = this.#now()
    this.#expire(now)

    if (
      !this.#consume(
        this.#global,
        now,
        DHT_WIRE_LIMITS.bucketRefillPerSecond,
        DHT_WIRE_LIMITS.globalBurst
      )
    ) {
      return false
    }

    let bucket = this.#sources.get(source)
    if (bucket) this.#sources.delete(source)
    else bucket = { tokens: DHT_WIRE_LIMITS.sourceBurst, updatedAtMs: now }
    const accepted = this.#consume(
      bucket,
      now,
      DHT_WIRE_LIMITS.sourceRefillPerSecond,
      DHT_WIRE_LIMITS.sourceBurst
    )
    this.#sources.set(source, bucket)
    if (this.#sources.size > DHT_WIRE_LIMITS.maxSourceEntries) {
      const oldest = this.#sources.keys().next().value
      if (oldest !== undefined) this.#sources.delete(oldest)
    }
    return accepted
  }

  #consume(
    bucket: Bucket,
    now: number,
    refillPerSecond: number,
    burst: number
  ): boolean {
    const elapsedMs = Math.max(now - bucket.updatedAtMs, 0)
    bucket.tokens = Math.min(
      burst,
      bucket.tokens + (elapsedMs * refillPerSecond) / 1_000
    )
    bucket.updatedAtMs = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  #expire(now: number): void {
    for (const [source, bucket] of this.#sources) {
      if (now - bucket.updatedAtMs < DHT_WIRE_LIMITS.sourceExpiryMs) break
      this.#sources.delete(source)
    }
  }
}
