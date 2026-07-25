import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  addPeerTracked,
  bindTrackedPeerLifecycle,
  type TrackedWebTorrentPeer
} from './webtorrent-peer-adapter'

function handle(id: unknown): EventEmitter & TrackedWebTorrentPeer {
  const peer = new EventEmitter() as EventEmitter & TrackedWebTorrentPeer
  peer.connected = false
  peer.destroy = vi.fn()
  peer.id = id
  return peer
}

describe('addPeerTracked', () => {
  it('recovers the exact internal record behind a successful public boolean', () => {
    const records = new Map<unknown, TrackedWebTorrentPeer>()
    const peer = handle('203.0.113.1:6881')
    const torrent = {
      _peers: records,
      addPeer: (identity: unknown) => {
        records.set(identity, peer)
        return true
      },
      removePeer: vi.fn()
    }

    expect(addPeerTracked(torrent, '203.0.113.1:6881', 'tracker')).toBe(peer)
    expect(torrent.removePeer).not.toHaveBeenCalled()
  })

  it('uses an object peer id exactly as WebTorrent keys its map', () => {
    const records = new Map<unknown, TrackedWebTorrentPeer>()
    const transport = { id: 'remote-peer-id', remoteAddress: '203.0.113.2' }
    const peer = handle(transport.id)
    const torrent = {
      _peers: records,
      addPeer: () => {
        records.set(transport.id, peer)
        return true
      },
      removePeer: vi.fn()
    }

    expect(addPeerTracked(torrent, transport)).toBe(peer)
  })

  it('removes an accepted peer when the guarded runtime shape is unavailable', () => {
    const removePeer = vi.fn()
    const torrent = {
      addPeer: () => true,
      removePeer
    }

    expect(addPeerTracked(torrent, '203.0.113.3:6881')).toBe(false)
    expect(removePeer).toHaveBeenCalledWith('203.0.113.3:6881')
  })

  it('leaves a publicly rejected peer untouched', () => {
    const removePeer = vi.fn()
    const torrent = {
      _peers: new Map(),
      addPeer: () => false,
      removePeer
    }

    expect(addPeerTracked(torrent, '203.0.113.4:6881')).toBe(false)
    expect(removePeer).not.toHaveBeenCalled()
  })

  it('moves pending capacity on connect and retires the record on destroy', () => {
    const peer = handle('203.0.113.5:6881')
    const counted = vi.fn()
    const rejected = vi.fn()
    const retired = vi.fn()

    expect(bindTrackedPeerLifecycle(peer, { counted, rejected, retired })).toBe(
      true
    )
    expect(counted).not.toHaveBeenCalled()

    peer.emit('connect')
    expect(counted).toHaveBeenCalledOnce()
    peer.destroy()
    expect(retired).toHaveBeenCalledOnce()
    expect(rejected).not.toHaveBeenCalled()
  })

  it('releases a reservation when no tracked lifecycle is available', () => {
    const rejected = vi.fn()

    expect(
      bindTrackedPeerLifecycle(true, {
        counted: vi.fn(),
        rejected,
        retired: vi.fn()
      })
    ).toBe(false)
    expect(rejected).toHaveBeenCalledOnce()
  })

  it('retires a pending reservation when the peer fails before connect', () => {
    const peer = handle('203.0.113.6:6881')
    const counted = vi.fn()
    const retired = vi.fn()
    bindTrackedPeerLifecycle(peer, {
      counted,
      rejected: vi.fn(),
      retired
    })

    peer.destroy()

    expect(counted).not.toHaveBeenCalled()
    expect(retired).toHaveBeenCalledOnce()
  })
})
