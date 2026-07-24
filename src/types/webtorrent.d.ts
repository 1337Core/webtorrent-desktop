declare module 'webtorrent' {
  export interface WebTorrentOptions {
    dht?: boolean
    lsd?: boolean
    natPmp?: boolean
    natUpnp?: boolean
    utp?: boolean
  }

  export default class WebTorrent {
    static VERSION?: string
    static WEBRTC_SUPPORT?: boolean

    constructor(options?: WebTorrentOptions)

    utp: boolean

    destroy(callback?: (error?: Error) => void): void
  }
}
