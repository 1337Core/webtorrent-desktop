import { WEBTORRENT_USER_AGENT } from './client-config'

export const TRACKER_HTTP_EGRESS_PROFILE = Object.freeze({
  absoluteDeadlineMs: 15_000,
  globalConcurrency: 8,
  headers: Object.freeze({
    accept:
      'application/x-bittorrent, text/plain;q=0.9, application/octet-stream;q=0.8',
    'accept-encoding': 'identity',
    'cache-control': 'no-store',
    'user-agent': WEBTORRENT_USER_AGENT
  }),
  maxAcceptedPeers: 82,
  maxAnnounceIntervalSeconds: 86_400,
  maxRedirects: 3,
  maxResponseBytes: 1_048_576,
  minAnnounceIntervalSeconds: 60,
  requestedPeers: 50
})
