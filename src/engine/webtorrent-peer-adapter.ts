export type TrackedWebTorrentPeer = {
  connected?: boolean
  destroy(...args: unknown[]): void
  id?: unknown
  once?(event: string, listener: () => void): unknown
}

type PublicPeerTorrent = {
  addPeer(peer: unknown, source?: string): unknown
  removePeer?(peer: unknown): void
}

function isTrackedPeer(value: unknown): value is TrackedWebTorrentPeer {
  if (typeof value !== 'object' || value === null) return false
  const peer = value as Partial<TrackedWebTorrentPeer>
  return (
    typeof peer.destroy === 'function' &&
    (peer.connected === true || typeof peer.once === 'function')
  )
}

export function bindTrackedPeerLifecycle(
  value: unknown,
  callbacks: Readonly<{
    counted: () => void
    rejected: () => void
    retired: () => void
  }>
): boolean {
  if (!isTrackedPeer(value)) {
    callbacks.rejected()
    return false
  }
  if (value.connected) callbacks.counted()
  else value.once?.('connect', callbacks.counted)
  const destroy = value.destroy.bind(value)
  value.destroy = (...args: unknown[]) => {
    callbacks.retired()
    destroy(...args)
  }
  return true
}

/**
 * WebTorrent's public `addPeer` reports only a boolean even though the
 * internal peer record owns the connect/failure lifecycle needed by the
 * engine-wide transport budget. This is the one narrow compatibility adapter:
 * after a successful public handoff it recovers only that exact record from
 * the runtime-guarded peer map. If the expected shape is absent, the accepted
 * peer is removed immediately rather than leaving unaccounted work behind.
 */
export function addPeerTracked(
  torrent: PublicPeerTorrent,
  peer: unknown,
  source?: string
): TrackedWebTorrentPeer | false {
  const accepted = torrent.addPeer(peer, source)
  if (!accepted) return false
  if (isTrackedPeer(accepted)) return accepted

  const records = Reflect.get(torrent, '_peers') as unknown
  const get =
    typeof records === 'object' &&
    records !== null &&
    typeof Reflect.get(records, 'get') === 'function'
      ? (Reflect.get(records, 'get') as (key: unknown) => unknown).bind(records)
      : null
  const identity =
    typeof peer === 'object' && peer !== null && 'id' in peer
      ? Reflect.get(peer, 'id') || peer
      : peer
  const tracked = get?.(identity)
  if (isTrackedPeer(tracked)) return tracked

  try {
    torrent.removePeer?.(peer)
  } catch {
    // The caller still treats the guarded handoff as failed.
  }
  return false
}
