const MAX_TORRENT_BYTES = 10_000_000
const MAX_DEPTH = 32
const MAX_VALUES = 1_000_000
const MAX_INTEGER_DIGITS = 16
const MAX_STRING_LENGTH_DIGITS = 8
const ASCII_COLON = 0x3a
const ASCII_DICTIONARY = 0x64
const ASCII_END = 0x65
const ASCII_INTEGER = 0x69
const ASCII_LIST = 0x6c
const ASCII_MINUS = 0x2d
const ASCII_ZERO = 0x30
const ASCII_NINE = 0x39
const INFO_KEY = new Uint8Array([0x69, 0x6e, 0x66, 0x6f])

export type StrictBencodeScan = Readonly<{
  infoEnd: number
  infoStart: number
  valueCount: number
}>

export class StrictBencodeError extends Error {
  readonly code:
    | 'DEPTH_LIMIT'
    | 'DICTIONARY_ORDER'
    | 'DUPLICATE_KEY'
    | 'INFO_MISSING'
    | 'INFO_NOT_DICTIONARY'
    | 'INVALID_INTEGER'
    | 'INVALID_STRING_LENGTH'
    | 'INVALID_TOKEN'
    | 'SIZE_LIMIT'
    | 'TRAILING_DATA'
    | 'TRUNCATED'
    | 'VALUE_LIMIT'

  constructor(code: StrictBencodeError['code']) {
    super(`Invalid canonical torrent bencode: ${code}.`)
    this.name = 'StrictBencodeError'
    this.code = code
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return compareBytes(left, right) === 0
}

class Scanner {
  readonly #bytes: Uint8Array
  #index = 0
  #valueCount = 0
  #infoStart: number | null = null
  #infoEnd: number | null = null

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  scan(): StrictBencodeScan {
    if (this.#bytes.byteLength > MAX_TORRENT_BYTES) {
      throw new StrictBencodeError('SIZE_LIMIT')
    }
    if (this.#bytes[0] !== ASCII_DICTIONARY) {
      throw new StrictBencodeError('INVALID_TOKEN')
    }

    this.#parseDictionary(0, true)
    if (this.#index !== this.#bytes.byteLength) {
      throw new StrictBencodeError('TRAILING_DATA')
    }
    if (this.#infoStart === null || this.#infoEnd === null) {
      throw new StrictBencodeError('INFO_MISSING')
    }
    return {
      infoEnd: this.#infoEnd,
      infoStart: this.#infoStart,
      valueCount: this.#valueCount
    }
  }

  #parseValue(depth: number): void {
    if (depth > MAX_DEPTH) throw new StrictBencodeError('DEPTH_LIMIT')
    this.#valueCount += 1
    if (this.#valueCount > MAX_VALUES) {
      throw new StrictBencodeError('VALUE_LIMIT')
    }

    const token = this.#bytes[this.#index]
    if (token === undefined) throw new StrictBencodeError('TRUNCATED')
    if (token === ASCII_DICTIONARY) {
      this.#parseDictionary(depth, false)
      return
    }
    if (token === ASCII_LIST) {
      this.#parseList(depth)
      return
    }
    if (token === ASCII_INTEGER) {
      this.#parseInteger()
      return
    }
    if (token >= ASCII_ZERO && token <= ASCII_NINE) {
      this.#parseByteString()
      return
    }
    throw new StrictBencodeError('INVALID_TOKEN')
  }

  #parseDictionary(depth: number, topLevel: boolean): void {
    this.#index += 1
    let previousKey: Uint8Array | null = null
    while (this.#bytes[this.#index] !== ASCII_END) {
      if (this.#index >= this.#bytes.byteLength) {
        throw new StrictBencodeError('TRUNCATED')
      }
      const key = this.#parseByteString()
      if (previousKey) {
        const comparison = compareBytes(previousKey, key)
        if (comparison === 0) throw new StrictBencodeError('DUPLICATE_KEY')
        if (comparison > 0) {
          throw new StrictBencodeError('DICTIONARY_ORDER')
        }
      }
      previousKey = key

      const valueStart = this.#index
      if (topLevel && equalBytes(key, INFO_KEY)) {
        if (this.#bytes[valueStart] !== ASCII_DICTIONARY) {
          throw new StrictBencodeError('INFO_NOT_DICTIONARY')
        }
        this.#infoStart = valueStart
      }
      this.#parseValue(depth + 1)
      if (topLevel && equalBytes(key, INFO_KEY)) {
        this.#infoEnd = this.#index
      }
    }
    this.#index += 1
  }

  #parseList(depth: number): void {
    this.#index += 1
    while (this.#bytes[this.#index] !== ASCII_END) {
      if (this.#index >= this.#bytes.byteLength) {
        throw new StrictBencodeError('TRUNCATED')
      }
      this.#parseValue(depth + 1)
    }
    this.#index += 1
  }

  #parseInteger(): void {
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
    if (digitStart === this.#index || this.#bytes[this.#index] !== ASCII_END) {
      throw new StrictBencodeError('INVALID_INTEGER')
    }

    const digits = this.#bytes.subarray(digitStart, this.#index)
    if (
      digits.byteLength > MAX_INTEGER_DIGITS ||
      (digits.byteLength > 1 && digits[0] === ASCII_ZERO) ||
      (this.#bytes[start] === ASCII_MINUS &&
        digits.byteLength === 1 &&
        digits[0] === ASCII_ZERO)
    ) {
      throw new StrictBencodeError('INVALID_INTEGER')
    }

    const text = new TextDecoder().decode(
      this.#bytes.subarray(start, this.#index)
    )
    const value = Number(text)
    if (!Number.isSafeInteger(value)) {
      throw new StrictBencodeError('INVALID_INTEGER')
    }
    this.#index += 1
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
      throw new StrictBencodeError('INVALID_STRING_LENGTH')
    }

    const lengthBytes = this.#bytes.subarray(lengthStart, this.#index)
    if (
      lengthBytes.byteLength > MAX_STRING_LENGTH_DIGITS ||
      (lengthBytes.byteLength > 1 && lengthBytes[0] === ASCII_ZERO)
    ) {
      throw new StrictBencodeError('INVALID_STRING_LENGTH')
    }
    const length = Number(new TextDecoder().decode(lengthBytes))
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new StrictBencodeError('INVALID_STRING_LENGTH')
    }

    this.#index += 1
    const valueStart = this.#index
    const valueEnd = valueStart + length
    if (valueEnd > this.#bytes.byteLength) {
      throw new StrictBencodeError('TRUNCATED')
    }
    this.#index = valueEnd
    return this.#bytes.subarray(valueStart, valueEnd)
  }
}

export function scanStrictTorrentBencode(bytes: Uint8Array): StrictBencodeScan {
  return new Scanner(bytes).scan()
}
