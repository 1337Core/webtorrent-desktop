import { describe, expect, it } from 'vitest'
import { PeerAdmissionPolicy } from './peer-admission'

function peerId(value: number): Uint8Array {
  return new Uint8Array(20).fill(value)
}

describe('PeerAdmissionPolicy', () => {
  it('allows public IPv4 and only consented RFC1918 peers', () => {
    const publicOnly = new PeerAdmissionPolicy({
      allowPrivateNetwork: false,
      localPeerId: peerId(1)
    })
    const privateMode = new PeerAdmissionPolicy({
      allowPrivateNetwork: true,
      localPeerId: peerId(1)
    })

    expect(publicOnly.allows({ address: '8.8.8.8' })).toBe(true)
    expect(publicOnly.allows({ address: '10.0.0.1' })).toBe(false)
    expect(privateMode.allows({ address: '10.0.0.1' })).toBe(true)
    expect(privateMode.allows({ address: '192.168.1.2' })).toBe(true)

    for (const blocked of [
      '127.0.0.1',
      '169.254.1.1',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'not-an-address'
    ]) {
      expect(privateMode.allows({ address: blocked })).toBe(false)
    }
  })

  it('rejects the snapshotted local peer ID and malformed identities', () => {
    const localPeerId = peerId(7)
    const policy = new PeerAdmissionPolicy({
      allowPrivateNetwork: false,
      localPeerId
    })
    localPeerId.fill(8)

    expect(policy.allows({ address: '8.8.8.8', peerId: peerId(7) })).toBe(false)
    expect(policy.allows({ address: '8.8.8.8', peerId: localPeerId })).toBe(
      true
    )
    expect(
      policy.allows({ address: '8.8.8.8', peerId: Uint8Array.of(1) })
    ).toBe(false)
  })
})
