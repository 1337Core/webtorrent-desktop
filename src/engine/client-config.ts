import { randomBytes } from 'node:crypto'
import type { WebTorrentOptions } from 'webtorrent'

export const WEBTORRENT_USER_AGENT =
  'WebTorrent Updated/1.0.0-dev (+https://github.com/1337Core/webtorrent-desktop)'

export type EngineClientProfile = 'private' | 'public' | 'staging'

type ClientConfigOptions = Readonly<{
  dht?: false | Record<string, unknown>
  peerId?: Uint8Array
}>

export function createPeerId(): Uint8Array {
  const suffix = randomBytes(9).toString('base64url')
  return new TextEncoder().encode(`-WU0100-${suffix}`)
}

export function createClientOptions(
  profile: EngineClientProfile,
  options: ClientConfigOptions = {}
): WebTorrentOptions {
  const dht = profile === 'private' ? false : (options.dht ?? false)

  return {
    dht,
    downloadLimit: -1,
    lsd: false,
    // WebTorrent applies maxConns per torrent. Two staging torrents may run,
    // so four each is the exact eight-transport aggregate ceiling.
    maxConns: profile === 'staging' ? 4 : 55,
    natPmp: false,
    natUpnp: false,
    peerId: options.peerId ?? createPeerId(),
    secure: 1,
    seedOutgoingConnections: true,
    torrentPort: 0,
    tracker: false,
    uploadLimit: -1,
    userAgent: WEBTORRENT_USER_AGENT,
    utPex: profile === 'public',
    utp: false,
    webSeeds: false
  }
}
