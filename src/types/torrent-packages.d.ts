declare module 'bencode' {
  const bencode: {
    byteLength(value: unknown): number
    decode(value: string | Uint8Array): unknown
    encode(value: unknown): Uint8Array
    encodingLength(value: unknown): number
  }
  export default bencode
}

declare module 'parse-torrent' {
  export interface ParsedTorrentFile {
    length: number
    name: string
    offset: number
    path: string
  }

  export interface ParsedTorrent {
    announce: string[]
    comment?: string
    created?: Date
    createdBy?: string
    files?: ParsedTorrentFile[]
    info?: Record<string, unknown>
    infoBuffer?: Uint8Array
    infoHash: string
    infoHashBuffer?: Uint8Array
    infoHashV2?: string
    lastPieceLength?: number
    length?: number
    name?: string
    peerAddresses?: string[]
    pieces?: string[]
    pieceLength?: number
    private?: boolean
    so?: number[]
    urlList: string[]
    xs?: string | string[]
    [key: string]: unknown
  }

  function parseTorrent(
    torrentId: string | Uint8Array | ParsedTorrent
  ): Promise<ParsedTorrent>

  export function toMagnetURI(parsed: ParsedTorrent): string
  export function toTorrentFile(parsed: ParsedTorrent): Uint8Array
  export default parseTorrent
}

declare module 'create-torrent' {
  export interface CreateTorrentOptions {
    announceList?: string[][]
    comment?: string
    createdBy?: string
    creationDate?: Date
    filterJunkFiles?: boolean
    maxPieceLength?: number
    name?: string
    onProgress?: (hashedBytes: number, totalBytes: number) => void
    pieceLength?: number
    private?: boolean
    urlList?: string[]
  }

  function createTorrent(
    input: string | string[] | Uint8Array,
    options: CreateTorrentOptions,
    callback: (error: Error | null, torrent?: Uint8Array) => void
  ): void

  export default createTorrent
}

declare module 'bittorrent-tracker/server' {
  import type { EventEmitter } from 'node:events'

  export default class TrackerServer extends EventEmitter {
    constructor(options?: { http?: boolean; udp?: boolean; ws?: boolean })

    close(callback?: (error?: Error) => void): void
    listen(port: number, hostname: string, callback?: () => void): void
    readonly http: {
      address():
        | string
        | {
            address: string
            family: string
            port: number
          }
        | null
    } | null
  }
}

declare module '@thaunknown/simple-peer' {
  /**
   * The exact surface the engine's WebRTC signaling uses. Every peer is
   * constructed with the engine's own fixed configuration; nothing here is
   * derived from a tracker message.
   */
  export interface SimplePeerOptions {
    config?: {
      /**
       * Pins the transport to one local address. The engine never sets it;
       * only loopback test fixtures do.
       */
      bindAddress?: string
      iceServers?: readonly unknown[]
      sdpSemantics?: string
    }
    iceCompleteTimeout?: number
    initiator?: boolean
    trickle?: boolean
  }

  export default class SimplePeer {
    constructor(options?: SimplePeerOptions)

    destroy(error?: Error): void
    id?: string
    on(event: string, listener: (...args: unknown[]) => void): this
    readonly remoteAddress?: string
    signal(description: unknown): void
  }
}
