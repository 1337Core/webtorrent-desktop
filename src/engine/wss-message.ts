import { isPrivateNetworkIpv4, isPublicIpv4 } from './network-policy'

export const WSS_MESSAGE_LIMITS = Object.freeze({
  maxCandidates: 32,
  maxFailureBytes: 1_024,
  maxKeys: 16,
  maxMessageBytes: 131_072,
  maxSdpBytes: 65_536,
  maxSdpLineBytes: 2_048,
  maxSdpLines: 512,
  maxTrackerIdBytes: 128,
  peerIdBytes: 20
})

export type WssMessageErrorCode =
  | 'FIELD_INVALID'
  | 'MESSAGE_TOO_LARGE'
  | 'NOT_AN_OBJECT'
  | 'NO_USABLE_CANDIDATE'
  | 'SDP_INVALID'
  | 'TOO_MANY_KEYS'
  | 'UNPARSEABLE'

export class WssMessageError extends Error {
  readonly code: WssMessageErrorCode

  constructor(code: WssMessageErrorCode) {
    super(`Tracker WSS message was rejected: ${code}.`)
    this.name = 'WssMessageError'
    this.code = code
  }
}

const RECOGNIZED_KEYS = new Set([
  'action',
  'answer',
  'complete',
  'failure reason',
  'incomplete',
  'info_hash',
  'interval',
  'min interval',
  'offer',
  'offer_id',
  'offers',
  'peer_id',
  'to_peer_id',
  'tracker id',
  'warning message'
])

type WssAnnounceResponse = Readonly<{
  complete: number | null
  failureReason: string | null
  incomplete: number | null
  infoHash: string
  interval: number | null
  trackerId: string | null
  warningMessage: string | null
}>

type WssSignal = Readonly<{
  infoHash: string
  kind: 'answer' | 'offer'
  offerId: string
  peerId: string
  sdp: string
}>

export type WssInboundMessage =
  | Readonly<{ kind: 'announce'; value: WssAnnounceResponse }>
  | Readonly<{ kind: 'signal'; value: WssSignal }>

const utf8Encoder = new TextEncoder()

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') throw new WssMessageError('FIELD_INVALID')
  if (utf8Encoder.encode(value).byteLength > maximumBytes) {
    throw new WssMessageError('FIELD_INVALID')
  }
  return value
}

/**
 * Raw `info_hash`, `peer_id`, `offer_id`, and `to_peer_id` values are exactly
 * twenty binary bytes carried as a JSON string, so each code unit must fit in
 * one byte.
 */
function binaryIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== WSS_MESSAGE_LIMITS.peerIdBytes
  ) {
    throw new WssMessageError('FIELD_INVALID')
  }
  for (let index = 0; index < value.length; index += 1) {
    if ((value.codePointAt(index) ?? 0) > 0xff) {
      throw new WssMessageError('FIELD_INVALID')
    }
  }
  return value
}

function optionalCount(value: unknown): number | null {
  if (value === undefined) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new WssMessageError('FIELD_INVALID')
  }
  return value
}

/**
 * Parses one bounded UTF-8 JSON tracker frame. The byte check runs before the
 * parse, and only a plain top-level object with recognized keys is accepted.
 */
export function parseWssMessage(raw: string): WssInboundMessage {
  if (utf8Encoder.encode(raw).byteLength > WSS_MESSAGE_LIMITS.maxMessageBytes) {
    throw new WssMessageError('MESSAGE_TOO_LARGE')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new WssMessageError('UNPARSEABLE')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new WssMessageError('NOT_AN_OBJECT')
  }

  const message = parsed as Record<string, unknown>
  const keys = Object.keys(message)
  if (keys.length > WSS_MESSAGE_LIMITS.maxKeys) {
    throw new WssMessageError('TOO_MANY_KEYS')
  }
  for (const key of keys) {
    if (!RECOGNIZED_KEYS.has(key)) throw new WssMessageError('FIELD_INVALID')
  }
  if (message.action !== undefined && message.action !== 'announce') {
    throw new WssMessageError('FIELD_INVALID')
  }

  const infoHash = binaryIdentity(message.info_hash)

  if (message.offer !== undefined || message.answer !== undefined) {
    const kind = message.offer === undefined ? 'answer' : 'offer'
    const envelope = kind === 'offer' ? message.offer : message.answer
    return {
      kind: 'signal',
      value: {
        infoHash,
        kind,
        offerId: binaryIdentity(message.offer_id),
        peerId: binaryIdentity(message.peer_id),
        sdp: parseSessionDescription(envelope, kind)
      }
    }
  }

  return {
    kind: 'announce',
    value: {
      complete: optionalCount(message.complete),
      failureReason:
        message['failure reason'] === undefined
          ? null
          : boundedString(
              message['failure reason'],
              WSS_MESSAGE_LIMITS.maxFailureBytes
            ),
      incomplete: optionalCount(message.incomplete),
      infoHash,
      interval: optionalCount(message.interval),
      trackerId:
        message['tracker id'] === undefined
          ? null
          : boundedString(
              message['tracker id'],
              WSS_MESSAGE_LIMITS.maxTrackerIdBytes
            ),
      warningMessage:
        message['warning message'] === undefined
          ? null
          : boundedString(
              message['warning message'],
              WSS_MESSAGE_LIMITS.maxFailureBytes
            )
    }
  }
}

/** An offer or answer is exactly a bounded `{ type, sdp }` object. */
function parseSessionDescription(
  value: unknown,
  kind: 'answer' | 'offer'
): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new WssMessageError('SDP_INVALID')
  }
  const envelope = value as Record<string, unknown>
  const keys = Object.keys(envelope)
  if (keys.length !== 2 || envelope.type !== kind) {
    throw new WssMessageError('SDP_INVALID')
  }
  return validateSdp(envelope.sdp)
}

/**
 * Accepts only one data-channel application section with bounded lines and no
 * audio or video, so a tracker cannot steer the peer connection into capturing
 * media.
 */
export function validateSdp(value: unknown): string {
  if (typeof value !== 'string') throw new WssMessageError('SDP_INVALID')
  if (utf8Encoder.encode(value).byteLength > WSS_MESSAGE_LIMITS.maxSdpBytes) {
    throw new WssMessageError('SDP_INVALID')
  }

  const lines = value.split(/\r\n|\n/u)
  if (lines.length > WSS_MESSAGE_LIMITS.maxSdpLines) {
    throw new WssMessageError('SDP_INVALID')
  }

  let applicationSections = 0
  let candidates = 0
  for (const line of lines) {
    if (
      utf8Encoder.encode(line).byteLength > WSS_MESSAGE_LIMITS.maxSdpLineBytes
    ) {
      throw new WssMessageError('SDP_INVALID')
    }
    if (line.startsWith('m=')) {
      if (line.startsWith('m=audio') || line.startsWith('m=video')) {
        throw new WssMessageError('SDP_INVALID')
      }
      if (!line.startsWith('m=application')) {
        throw new WssMessageError('SDP_INVALID')
      }
      applicationSections += 1
    }
    if (line.startsWith('a=candidate:') || line.startsWith('candidate:')) {
      candidates += 1
    }
  }
  if (
    applicationSections !== 1 ||
    candidates > WSS_MESSAGE_LIMITS.maxCandidates
  ) {
    throw new WssMessageError('SDP_INVALID')
  }
  return value
}

export type IceFilterOptions = Readonly<{ allowPrivateNetwork: boolean }>

/**
 * Removes every candidate the fork will not use before native parsing, in both
 * directions: IPv6, hostnames, mDNS, loopback, link-local, CGNAT, multicast,
 * reserved addresses, and `remote-candidates` lines. A signal with no usable
 * candidate is rejected rather than sent or accepted.
 */
export function filterIceCandidates(
  sdp: string,
  options: IceFilterOptions
): string {
  const lines = sdp.split(/\r\n|\n/u)
  const kept: string[] = []
  let sawCandidate = false

  for (const line of lines) {
    const isCandidate =
      line.startsWith('a=candidate:') || line.startsWith('candidate:')
    if (line.includes('remote-candidates')) continue
    if (!isCandidate) {
      kept.push(line)
      continue
    }
    const address = line.split(' ')[4]
    if (
      address !== undefined &&
      (isPublicIpv4(address) ||
        (options.allowPrivateNetwork && isPrivateNetworkIpv4(address)))
    ) {
      sawCandidate = true
      kept.push(line)
    }
  }

  if (!sawCandidate) throw new WssMessageError('NO_USABLE_CANDIDATE')
  return kept.join('\r\n')
}
