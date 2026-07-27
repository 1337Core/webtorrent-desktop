declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'
  import type { Readable } from 'node:stream'

  export type ChunkStoreCallback = (error?: Error | null) => void

  export interface ChunkStore {
    readonly chunkLength: number
    readonly length: number
    close(callback?: ChunkStoreCallback): void
    destroy(callback?: ChunkStoreCallback): void
    get(
      index: number,
      options:
        | {
            length?: number
            offset?: number
          }
        | ChunkStoreCallback,
      callback?: (error: Error | null, data?: Uint8Array) => void
    ): void
    put(index: number, data: Uint8Array, callback?: ChunkStoreCallback): void
  }

  export interface ChunkStoreConstructor {
    new (
      chunkLength: number,
      options: {
        length: number
      }
    ): ChunkStore
  }

  export interface TrackerProxyOptions {
    httpAgent?: object
    httpsAgent?: object
  }

  export interface TrackerOptions {
    announce?: string[]
    proxyOpts?: TrackerProxyOptions
    rtcConfig?: {
      iceServers: Array<{
        urls: string | string[]
      }>
    }
    wrtc?: object | false | (() => object)
  }

  export interface WebTorrentOptions {
    dht?: boolean | Record<string, unknown>
    downloadLimit?: number
    lsd?: boolean
    maxConns?: number
    natPmp?: boolean
    natUpnp?: boolean | 'permanent'
    peerId?: string | Uint8Array
    secure?: 0 | 1 | 2
    seedOutgoingConnections?: boolean
    torrentPort?: number
    tracker?: false | TrackerOptions
    uploadLimit?: number
    userAgent?: string
    utPex?: boolean
    utp?: boolean
    webSeeds?: boolean
  }

  export interface TorrentOptions {
    addUID?: boolean
    announce?: string[]
    bitfield?: Uint8Array
    deselect?: boolean
    destroyStoreOnDestroy?: boolean
    path?: string
    paused?: boolean
    private?: boolean
    secure?: 0 | 1 | 2
    skipVerify?: boolean
    store?: ChunkStoreConstructor
    storeCacheSlots?: number
    storeOpts?: Record<string, unknown>
    urlList?: string[]
  }

  export interface SeedOptions extends TorrentOptions {
    announceList?: string[][]
    comment?: string
    createdBy?: string
    creationDate?: Date
    filterJunkFiles?: boolean
    name?: string
    onProgress?: (hashedBytes: number, totalBytes: number) => void
    private?: boolean
  }

  export interface TorrentWire {
    peerId?: string
    type?: string
  }

  export interface TorrentFile extends EventEmitter {
    readonly done: boolean
    readonly downloaded: number
    readonly length: number
    readonly name: string
    readonly offset: number
    readonly path: string
    readonly progress: number
    readonly type: string

    arrayBuffer(options?: {
      start?: number
      end?: number
    }): Promise<ArrayBuffer>
    createReadStream(options?: { start?: number; end?: number }): Readable
    deselect(): void
    select(priority?: number): void
    [Symbol.asyncIterator](options?: {
      start?: number
      end?: number
    }): AsyncIterator<Uint8Array>
  }

  export interface Torrent extends EventEmitter {
    readonly announce: string[]
    readonly downloaded: number
    readonly downloadSpeed: number
    readonly files: TorrentFile[]
    readonly infoHash: string
    readonly length: number
    readonly magnetURI: string
    readonly name: string
    readonly numPeers: number
    readonly path: string
    readonly pieceLength: number
    readonly progress: number
    readonly ready: boolean
    readonly received: number
    readonly timeRemaining: number
    readonly torrentFile: Uint8Array
    readonly uploaded: number
    readonly uploadSpeed: number
    readonly wires: TorrentWire[]
    destroyed: boolean
    done: boolean
    paused: boolean
    private: boolean

    addPeer(peer: string | object, source?: string): boolean
    deselect(start: number, end: number): void
    select(start: number, end: number, priority?: number): void
    destroy(
      options?: { destroyStore?: boolean } | ((error?: Error) => void),
      callback?: (error?: Error) => void
    ): void
    pause(): void
    resume(): void
  }

  export default class WebTorrent extends EventEmitter {
    static VERSION?: string
    static WEBRTC_SUPPORT?: boolean
    static UTP_SUPPORT?: boolean

    constructor(options?: WebTorrentOptions)

    readonly address: () => {
      address: string
      family: string
      port: number
    } | null
    readonly downloadSpeed: number
    readonly peerId: string
    readonly torrentPort: number
    readonly torrents: Torrent[]
    readonly uploadSpeed: number
    readonly utp: boolean
    destroyed: boolean

    add(
      torrentId: string | Uint8Array | Record<string, unknown>,
      options?: TorrentOptions,
      onTorrent?: (torrent: Torrent) => void
    ): Torrent
    destroy(callback?: (error?: Error) => void): void
    get(torrentId: string | Uint8Array | Torrent): Promise<Torrent | null>
    remove(
      torrentId: string | Uint8Array | Torrent,
      options?: { destroyStore?: boolean } | null,
      callback?: (error?: Error) => void
    ): Promise<void>
    seed(
      input: string | string[] | Uint8Array,
      options?: SeedOptions,
      onSeed?: (torrent: Torrent) => void
    ): Torrent
  }
}
