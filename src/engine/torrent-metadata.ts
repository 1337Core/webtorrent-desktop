import { createHash } from 'node:crypto'
import path from 'node:path'
import bencode from 'bencode'
import parseTorrent, { toMagnetURI, type ParsedTorrent } from 'parse-torrent'
import type { EgressPolicy } from './network-policy'
import { scanStrictTorrentBencode } from './strict-bencode'

export const TORRENT_METADATA_LIMITS = Object.freeze({
  bytes: 10_000_000,
  files: 100_000,
  magnetBytes: 65_536,
  magnetParameters: 256,
  pathBytes: 4_096,
  pathSegments: 128,
  pieceCount: 262_144,
  pieceLength: 32 * 1024 * 1024,
  selectionIndexes: 100_000,
  selectionTerms: 1_024,
  segmentBytes: 255,
  trackerCount: 32,
  trackerTiers: 8,
  trackersPerTier: 4,
  urlBytes: 2_048,
  webSeedCount: 32
})

type ValidatedTorrentFile = Readonly<{
  index: number
  length: number
  offset: number
  path: string
}>

export type ValidatedTorrentMetadata = Readonly<{
  announceTiers: ReadonlyArray<ReadonlyArray<string>>
  files: ReadonlyArray<ValidatedTorrentFile>
  infoHash: string
  length: number
  name: string
  pieceCount: number
  pieceLength: number
  private: boolean
  torrentBytes: Uint8Array
  warnings: ReadonlyArray<'TRACKER_TRANSPORT_DISABLED' | 'WEB_SEED_INVALID'>
  webSeeds: ReadonlyArray<string>
}>

export type CanonicalInfoIdentity = Readonly<{
  infoBytes: Uint8Array
  infoHash: string
}>

export type PreparedMagnet = Readonly<{
  dhtEnabled: boolean
  infoHash: string
  magnet: ParsedTorrent
  magnetUri: string
  selection: ReadonlyArray<number>
  trackers: ReadonlyArray<string>
  warnings: ReadonlyArray<'TRACKER_TRANSPORT_DISABLED' | 'WEB_SEED_INVALID'>
  webSeeds: ReadonlyArray<string>
  xsRemoved: boolean
}>

export class TorrentInputError extends Error {
  readonly code:
    | 'DHT_CONSENT_REQUIRED'
    | 'INFO_HASH_MISMATCH'
    | 'INVALID_MAGNET'
    | 'INVALID_METADATA'
    | 'LIMIT_EXCEEDED'
    | 'PRIVATE_TRACKER_REQUIRED'
    | 'UNSAFE_PATH'
    | 'UNSUPPORTED_V2'

  constructor(code: TorrentInputError['code']) {
    super(`Torrent input was rejected: ${code}.`)
    this.name = 'TorrentInputError'
    this.code = code
  }
}

type Dictionary = Record<string, unknown>

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()
const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const forbiddenPathCharacters = /[<>:"/\\|?*]/u

function dictionary(value: unknown): Dictionary {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  ) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  return value as Dictionary
}

function field(source: Dictionary, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined
}

function byteString(value: unknown): Uint8Array {
  if (!ArrayBuffer.isView(value)) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function decodeUtf8(value: unknown): string {
  try {
    return utf8Decoder.decode(byteString(value))
  } catch {
    throw new TorrentInputError('INVALID_METADATA')
  }
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  return value as number
}

function preferredUtf8(
  source: Dictionary,
  key: string,
  required = true
): string | null {
  const regularValue = field(source, key)
  const utf8Value = field(source, `${key}.utf-8`)
  if (regularValue === undefined && utf8Value === undefined) {
    if (required) throw new TorrentInputError('INVALID_METADATA')
    return null
  }

  const regular = regularValue === undefined ? null : decodeUtf8(regularValue)
  const utf8 = utf8Value === undefined ? null : decodeUtf8(utf8Value)
  if (
    regular !== null &&
    utf8 !== null &&
    regular.normalize('NFC') !== utf8.normalize('NFC')
  ) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  return utf8 ?? regular
}

function validatePathSegment(value: string): string {
  const bytes = utf8Encoder.encode(value)
  const hasControlCharacter = Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
  })
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    bytes.byteLength > TORRENT_METADATA_LIMITS.segmentBytes ||
    forbiddenPathCharacters.test(value) ||
    hasControlCharacter ||
    value.endsWith('.') ||
    value.endsWith(' ') ||
    windowsReservedName.test(value)
  ) {
    throw new TorrentInputError('UNSAFE_PATH')
  }
  return value
}

function pathIdentity(parts: readonly string[]): string {
  return parts
    .map(part => {
      let identity = part.normalize('NFD')
      for (let pass = 0; pass < 8; pass += 1) {
        const nextIdentity = identity
          .toUpperCase()
          .toLowerCase()
          .normalize('NFD')
        if (nextIdentity === identity) break
        identity = nextIdentity
      }
      return identity
    })
    .join('/')
}

function validatePath(parts: readonly string[]): string {
  if (
    parts.length === 0 ||
    parts.length > TORRENT_METADATA_LIMITS.pathSegments
  ) {
    throw new TorrentInputError('UNSAFE_PATH')
  }
  const validated = parts.map(validatePathSegment)
  const joined = validated.join('/')
  if (
    utf8Encoder.encode(joined).byteLength > TORRENT_METADATA_LIMITS.pathBytes
  ) {
    throw new TorrentInputError('UNSAFE_PATH')
  }
  return joined
}

function extractManifest(info: Dictionary): {
  files: Array<{ length: number; path: string }>
  length: number
  name: string
} {
  const name = validatePathSegment(preferredUtf8(info, 'name') as string)
  const rawFiles = field(info, 'files')
  const rawLength = field(info, 'length')
  const hasSingleLength = rawLength !== undefined
  if ((rawFiles !== undefined) === hasSingleLength) {
    throw new TorrentInputError('INVALID_METADATA')
  }

  const files: Array<{ length: number; path: string }> = []
  if (rawFiles === undefined) {
    files.push({
      length: safeInteger(rawLength),
      path: validatePath([name])
    })
  } else {
    if (
      !Array.isArray(rawFiles) ||
      rawFiles.length === 0 ||
      rawFiles.length > TORRENT_METADATA_LIMITS.files
    ) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
    for (const rawFile of rawFiles) {
      const file = dictionary(rawFile)
      const regularPath = field(file, 'path')
      const utf8Path = field(file, 'path.utf-8')
      if (regularPath === undefined && utf8Path === undefined) {
        throw new TorrentInputError('INVALID_METADATA')
      }
      const decodePath = (value: unknown): string[] => {
        if (
          !Array.isArray(value) ||
          value.length === 0 ||
          value.length > TORRENT_METADATA_LIMITS.pathSegments
        ) {
          throw new TorrentInputError('INVALID_METADATA')
        }
        return value.map(component => {
          const bytes = byteString(component)
          if (bytes.byteLength > TORRENT_METADATA_LIMITS.segmentBytes) {
            throw new TorrentInputError('UNSAFE_PATH')
          }
          return decodeUtf8(bytes)
        })
      }
      const regular = regularPath === undefined ? null : decodePath(regularPath)
      const utf8 = utf8Path === undefined ? null : decodePath(utf8Path)
      if (
        regular &&
        utf8 &&
        (regular.length !== utf8.length ||
          regular.some(
            (part, index) =>
              part.normalize('NFC') !== utf8[index]?.normalize('NFC')
          ))
      ) {
        throw new TorrentInputError('INVALID_METADATA')
      }
      const components = utf8 ?? regular
      if (!components) throw new TorrentInputError('INVALID_METADATA')
      files.push({
        length: safeInteger(field(file, 'length')),
        path: validatePath([name, ...components])
      })
    }
  }

  const identities = new Set<string>()
  const directoryIdentities = new Set<string>()
  let totalLength = 0
  for (const file of files) {
    const parts = file.path.split('/')
    const identity = pathIdentity(parts)
    if (identities.has(identity) || directoryIdentities.has(identity)) {
      throw new TorrentInputError('UNSAFE_PATH')
    }
    for (let index = 1; index < parts.length; index += 1) {
      const directoryIdentity = pathIdentity(parts.slice(0, index))
      if (identities.has(directoryIdentity)) {
        throw new TorrentInputError('UNSAFE_PATH')
      }
      directoryIdentities.add(directoryIdentity)
    }
    identities.add(identity)
    totalLength += file.length
    if (!Number.isSafeInteger(totalLength)) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
  }
  return { files, length: totalLength, name }
}

function decodeUrl(value: unknown): string {
  const result = decodeUtf8(value)
  if (
    utf8Encoder.encode(result).byteLength > TORRENT_METADATA_LIMITS.urlBytes
  ) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }
  return result
}

function rawTrackerTiers(root: Dictionary): string[][] {
  const announceList = field(root, 'announce-list')
  if (announceList !== undefined) {
    if (!Array.isArray(announceList)) {
      throw new TorrentInputError('INVALID_METADATA')
    }
    if (announceList.length > TORRENT_METADATA_LIMITS.trackerTiers) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
    if (announceList.length === 0) {
      const announce = field(root, 'announce')
      return announce === undefined ? [] : [[decodeUrl(announce)]]
    }
    let trackerCount = 0
    const tiers: string[][] = []
    for (const rawTier of announceList) {
      if (!Array.isArray(rawTier) || rawTier.length === 0) {
        throw new TorrentInputError('INVALID_METADATA')
      }
      if (rawTier.length > TORRENT_METADATA_LIMITS.trackersPerTier) {
        throw new TorrentInputError('LIMIT_EXCEEDED')
      }
      trackerCount += rawTier.length
      if (trackerCount > TORRENT_METADATA_LIMITS.trackerCount) {
        throw new TorrentInputError('LIMIT_EXCEEDED')
      }
      tiers.push(rawTier.map(decodeUrl))
    }
    return tiers
  }
  const announce = field(root, 'announce')
  return announce === undefined ? [] : [[decodeUrl(announce)]]
}

function rawWebSeeds(root: Dictionary): string[] {
  const value = field(root, 'url-list')
  if (value === undefined) return []
  if (ArrayBuffer.isView(value)) {
    const single = decodeUrl(value)
    return single === '' ? [] : [single]
  }
  if (!Array.isArray(value)) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  if (value.length > TORRENT_METADATA_LIMITS.webSeedCount) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }
  return value.map(decodeUrl)
}

function validateTrackerTiers(
  tiers: readonly (readonly string[])[],
  policy: EgressPolicy
): {
  tiers: string[][]
  warnings: Array<'TRACKER_TRANSPORT_DISABLED'>
} {
  const result: string[][] = []
  const seen = new Set<string>()
  const warnings: Array<'TRACKER_TRANSPORT_DISABLED'> = []
  for (const tier of tiers) {
    const validatedTier: string[] = []
    for (const value of tier) {
      let tracker: string
      try {
        tracker = policy.validateTrackerUrl(value)
      } catch {
        if (warnings.length === 0) {
          warnings.push('TRACKER_TRANSPORT_DISABLED')
        }
        continue
      }
      if (seen.has(tracker)) continue
      seen.add(tracker)
      validatedTier.push(tracker)
      if (seen.size > TORRENT_METADATA_LIMITS.trackerCount) {
        throw new TorrentInputError('LIMIT_EXCEEDED')
      }
    }
    if (validatedTier.length > 0) result.push(validatedTier)
  }
  return { tiers: result, warnings }
}

function validateWebSeeds(
  values: readonly string[],
  policy: EgressPolicy
): {
  values: string[]
  warnings: Array<'WEB_SEED_INVALID'>
} {
  const result: string[] = []
  const warnings: Array<'WEB_SEED_INVALID'> = []
  const seen = new Set<string>()
  for (const value of values) {
    try {
      const webSeed = policy.validateWebSeedUrl(value)
      if (!seen.has(webSeed)) {
        seen.add(webSeed)
        result.push(webSeed)
      }
    } catch {
      if (warnings.length === 0) warnings.push('WEB_SEED_INVALID')
    }
    if (result.length > TORRENT_METADATA_LIMITS.webSeedCount) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
  }
  return { values: result, warnings }
}

function copyOptionalTopLevelFields(
  source: Dictionary,
  target: Dictionary
): void {
  const creationDate = field(source, 'creation date')
  if (creationDate !== undefined) {
    target['creation date'] = safeInteger(creationDate)
  }
  for (const key of ['comment', 'created by'] as const) {
    const value = field(source, key)
    if (value === undefined) continue
    const bytes = byteString(value)
    const maximum = key === 'comment' ? 4_096 : 256
    if (bytes.byteLength > maximum) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
    decodeUtf8(bytes)
    target[key] = bytes
  }
}

/**
 * The synchronous canonical identity of raw torrent bytes.
 *
 * The metadata commit barrier runs inside WebTorrent's synchronous `metadata`
 * handler, so it cannot use the asynchronous validation path. This performs
 * the same strict scan, canonical re-encode, and v1 hash without touching
 * `parse-torrent`.
 */
export function canonicalInfoIdentity(
  input: Uint8Array
): CanonicalInfoIdentity {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength === 0 ||
    input.byteLength > TORRENT_METADATA_LIMITS.bytes
  ) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }

  let scan
  let root: Dictionary
  try {
    scan = scanStrictTorrentBencode(input)
    root = dictionary(bencode.decode(input))
  } catch (error) {
    if (error instanceof TorrentInputError) throw error
    throw new TorrentInputError('INVALID_METADATA')
  }

  const info = dictionary(field(root, 'info'))
  const exactInfoBytes = input.subarray(scan.infoStart, scan.infoEnd)
  const canonicalInfoBytes: Uint8Array = bencode.encode(info)
  if (
    exactInfoBytes.byteLength !== canonicalInfoBytes.byteLength ||
    exactInfoBytes.some((byte, index) => byte !== canonicalInfoBytes[index])
  ) {
    throw new TorrentInputError('INFO_HASH_MISMATCH')
  }

  return {
    infoBytes: exactInfoBytes.slice(),
    infoHash: createHash('sha1').update(exactInfoBytes).digest('hex')
  }
}

export async function validateTorrentMetadata(
  input: Uint8Array,
  policy: EgressPolicy,
  options: { expectedInfoHash?: string } = {}
): Promise<ValidatedTorrentMetadata> {
  if (
    input.byteLength === 0 ||
    input.byteLength > TORRENT_METADATA_LIMITS.bytes
  ) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }

  let scan
  let root: Dictionary
  try {
    scan = scanStrictTorrentBencode(input)
    root = dictionary(bencode.decode(input))
  } catch (error) {
    if (error instanceof TorrentInputError) throw error
    throw new TorrentInputError('INVALID_METADATA')
  }
  const info = dictionary(field(root, 'info'))
  if ('meta version' in info || 'file tree' in info || 'piece layers' in root) {
    throw new TorrentInputError('UNSUPPORTED_V2')
  }
  const rawTrackers = rawTrackerTiers(root)
  const rawSeedUrls = rawWebSeeds(root)

  const privateValue = field(info, 'private')
  if (privateValue !== undefined && privateValue !== 0 && privateValue !== 1) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  const isPrivate = privateValue === 1
  const manifest = extractManifest(info)

  const pieceLength = safeInteger(field(info, 'piece length'), 1)
  if (pieceLength > TORRENT_METADATA_LIMITS.pieceLength) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }
  const pieceBytes = byteString(field(info, 'pieces'))
  if (pieceBytes.byteLength % 20 !== 0) {
    throw new TorrentInputError('INVALID_METADATA')
  }
  const pieceCount = pieceBytes.byteLength / 20
  const expectedPieceCount =
    manifest.length === 0 ? 0 : Math.ceil(manifest.length / pieceLength)
  if (
    pieceCount !== expectedPieceCount ||
    pieceCount > TORRENT_METADATA_LIMITS.pieceCount
  ) {
    throw new TorrentInputError('INVALID_METADATA')
  }

  const exactInfoBytes = input.subarray(scan.infoStart, scan.infoEnd)
  const canonicalInfoBytes = bencode.encode(info)
  if (
    exactInfoBytes.byteLength !== canonicalInfoBytes.byteLength ||
    exactInfoBytes.some((byte, index) => byte !== canonicalInfoBytes[index])
  ) {
    throw new TorrentInputError('INFO_HASH_MISMATCH')
  }
  const exactInfoHash = createHash('sha1').update(exactInfoBytes).digest('hex')
  if (
    options.expectedInfoHash !== undefined &&
    (!/^[a-f\d]{40}$/u.test(options.expectedInfoHash) ||
      options.expectedInfoHash !== exactInfoHash)
  ) {
    throw new TorrentInputError('INFO_HASH_MISMATCH')
  }

  let parsed
  try {
    parsed = await parseTorrent(input)
  } catch {
    throw new TorrentInputError('INVALID_METADATA')
  }
  if (
    parsed.infoHashV2 ||
    parsed.infoHash !== exactInfoHash ||
    parsed.name !== manifest.name ||
    parsed.length !== manifest.length ||
    parsed.pieceLength !== pieceLength ||
    parsed.pieces?.length !== pieceCount ||
    parsed.files?.length !== manifest.files.length
  ) {
    throw new TorrentInputError('INFO_HASH_MISMATCH')
  }
  for (const [index, file] of manifest.files.entries()) {
    const parsedFile = parsed.files?.[index]
    if (
      !parsedFile ||
      parsedFile.path.split(path.sep).join('/') !== file.path ||
      parsedFile.length !== file.length
    ) {
      throw new TorrentInputError('INVALID_METADATA')
    }
  }

  const trackers = validateTrackerTiers(rawTrackers, policy)
  if (isPrivate && trackers.tiers.length === 0) {
    throw new TorrentInputError('PRIVATE_TRACKER_REQUIRED')
  }
  const webSeeds = validateWebSeeds(rawSeedUrls, policy)
  const sanitizedRoot: Dictionary = { info }
  if (trackers.tiers.length > 0) {
    sanitizedRoot.announce = trackers.tiers[0]?.[0]
    sanitizedRoot['announce-list'] = trackers.tiers
  }
  if (webSeeds.values.length > 0) {
    sanitizedRoot['url-list'] = webSeeds.values
  }
  copyOptionalTopLevelFields(root, sanitizedRoot)
  const torrentBytes = bencode.encode(sanitizedRoot)

  let offset = 0
  const files = manifest.files.map((file, index) => {
    const result = {
      index,
      length: file.length,
      offset,
      path: file.path
    }
    offset += file.length
    return result
  })

  return {
    announceTiers: trackers.tiers,
    files,
    infoHash: exactInfoHash,
    length: manifest.length,
    name: manifest.name,
    pieceCount,
    pieceLength,
    private: isPrivate,
    torrentBytes,
    warnings: [...trackers.warnings, ...webSeeds.warnings],
    webSeeds: webSeeds.values
  }
}

function decodeMagnetComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new TorrentInputError('INVALID_MAGNET')
  }
}

function normalizedBtih(topic: string): string {
  const value = topic.slice('urn:btih:'.length)
  if (/^[a-f\d]{40}$/iu.test(value)) return value.toLowerCase()
  if (!/^[a-z2-7]{32}$/iu.test(value)) {
    throw new TorrentInputError('INVALID_MAGNET')
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes = new Uint8Array(20)
  let accumulator = 0
  let bits = 0
  let byteIndex = 0
  for (const character of value.toUpperCase()) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new TorrentInputError('INVALID_MAGNET')
    accumulator = (accumulator << 5) | digit
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes[byteIndex] = (accumulator >>> bits) & 0xff
      byteIndex += 1
      accumulator &= (1 << bits) - 1
    }
  }
  if (byteIndex !== bytes.byteLength || bits !== 0) {
    throw new TorrentInputError('INVALID_MAGNET')
  }
  return Buffer.from(bytes).toString('hex')
}

function parseSelectionExpression(value: string): number[] {
  const terms = decodeMagnetComponent(value).split(',')
  if (
    terms.length === 0 ||
    terms.length > TORRENT_METADATA_LIMITS.selectionTerms
  ) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }

  const result: number[] = []
  const seen = new Set<number>()
  let expandedIndexCount = 0
  for (const term of terms) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(term)
    if (!match) throw new TorrentInputError('INVALID_MAGNET')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= TORRENT_METADATA_LIMITS.files
    ) {
      throw new TorrentInputError('INVALID_MAGNET')
    }
    expandedIndexCount += end - start + 1
    if (expandedIndexCount > TORRENT_METADATA_LIMITS.selectionIndexes) {
      throw new TorrentInputError('LIMIT_EXCEEDED')
    }
    for (let index = start; index <= end; index += 1) {
      if (!seen.has(index)) {
        seen.add(index)
        result.push(index)
      }
    }
  }
  return result
}

export async function prepareMagnet(
  input: string,
  policy: EgressPolicy,
  options: { allowDht: boolean }
): Promise<PreparedMagnet> {
  const normalizedInput = /^[a-f\d]{40}$/iu.test(input)
    ? `magnet:?xt=urn:btih:${input.toLowerCase()}`
    : input
  if (
    !normalizedInput.startsWith('magnet:?') ||
    utf8Encoder.encode(normalizedInput).byteLength >
      TORRENT_METADATA_LIMITS.magnetBytes
  ) {
    throw new TorrentInputError('INVALID_MAGNET')
  }

  const rawParameters = normalizedInput.slice('magnet:?'.length).split('&')
  if (
    rawParameters.length === 0 ||
    rawParameters.length > TORRENT_METADATA_LIMITS.magnetParameters
  ) {
    throw new TorrentInputError('LIMIT_EXCEEDED')
  }
  const exactTopics: string[] = []
  const safeParseParameters: string[] = []
  let selection: number[] = []
  let selectionSeen = false
  let xsRemoved = false
  for (const parameter of rawParameters) {
    const separator = parameter.indexOf('=')
    if (separator <= 0) throw new TorrentInputError('INVALID_MAGNET')
    const key = parameter.slice(0, separator)
    const value = parameter.slice(separator + 1)
    if (key === 'xt') exactTopics.push(decodeMagnetComponent(value))
    if (key === 'so') {
      if (selectionSeen) throw new TorrentInputError('INVALID_MAGNET')
      selectionSeen = true
      selection = parseSelectionExpression(value)
    }
    if (key === 'xs' || key === 'x.pe') xsRemoved = true
    if (key !== 'so' && key !== 'xs' && key !== 'x.pe') {
      safeParseParameters.push(parameter)
    }
  }
  if (
    exactTopics.length === 0 ||
    exactTopics.some(
      topic =>
        !/^urn:btih:[a-z2-7]{32}$/iu.test(topic) &&
        !/^urn:btih:[a-f\d]{40}$/iu.test(topic)
    )
  ) {
    throw new TorrentInputError(
      exactTopics.some(topic => /^urn:btmh:/iu.test(topic))
        ? 'UNSUPPORTED_V2'
        : 'INVALID_MAGNET'
    )
  }
  if (exactTopics.length !== 1) {
    throw new TorrentInputError('INVALID_MAGNET')
  }
  const exactTopicHash = normalizedBtih(exactTopics[0] as string)

  let parsed: ParsedTorrent
  try {
    parsed = await parseTorrent(`magnet:?${safeParseParameters.join('&')}`)
  } catch {
    throw new TorrentInputError('INVALID_MAGNET')
  }
  if (parsed.infoHashV2) throw new TorrentInputError('UNSUPPORTED_V2')
  if (
    !/^[a-f\d]{40}$/u.test(parsed.infoHash) ||
    parsed.infoHash !== exactTopicHash
  ) {
    throw new TorrentInputError('INVALID_MAGNET')
  }

  const trackerResult = validateTrackerTiers([parsed.announce ?? []], policy)
  const webSeedResult = validateWebSeeds(parsed.urlList ?? [], policy)
  // Unknown-privacy staging has two attributable transports: pinned HTTPS
  // announces and the app-owned bounded WSS signaling stack. Plain HTTP stays
  // disabled because it cannot provide either transport security or pinning.
  const trackers = trackerResult.tiers.flat().filter(tracker => {
    const protocol = new URL(tracker).protocol
    return protocol === 'https:' || protocol === 'wss:'
  })
  const stagingWarnings = [...trackerResult.warnings]
  if (
    trackers.length !== trackerResult.tiers.flat().length &&
    !stagingWarnings.includes('TRACKER_TRANSPORT_DISABLED')
  ) {
    stagingWarnings.push('TRACKER_TRANSPORT_DISABLED')
  }
  const dhtEnabled = trackers.length === 0
  if (dhtEnabled && !options.allowDht) {
    throw new TorrentInputError('DHT_CONSENT_REQUIRED')
  }

  const sanitized: ParsedTorrent = {
    announce: trackerResult.tiers.flat(),
    infoHash: parsed.infoHash,
    name:
      typeof parsed.name === 'string' &&
      utf8Encoder.encode(parsed.name).byteLength <=
        TORRENT_METADATA_LIMITS.pathBytes
        ? parsed.name
        : undefined,
    peerAddresses: [],
    so: selection,
    urlList: webSeedResult.values
  }
  const magnetUri = toMagnetURI(sanitized)

  return {
    dhtEnabled,
    infoHash: parsed.infoHash,
    magnet: sanitized,
    magnetUri,
    selection,
    trackers,
    warnings: [...stagingWarnings, ...webSeedResult.warnings],
    webSeeds: webSeedResult.values,
    xsRemoved
  }
}
