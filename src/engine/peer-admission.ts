import { isPrivateNetworkIpv4, isPublicIpv4 } from './network-policy'

const PEER_ID_BYTES = 20

export type PeerAdmissionCandidate = Readonly<{
  address: string
  peerId?: Uint8Array
}>

export type PeerAdmissionPolicyOptions = Readonly<{
  allowPrivateNetwork: boolean
  localPeerId: Uint8Array
}>

/**
 * One reusable admission boundary for peer candidates discovered outside
 * WebTorrent. Callers must still apply it immediately before every addPeer
 * handoff so no discovery source can bypass the current torrent policy.
 */
export class PeerAdmissionPolicy {
  readonly #allowPrivateNetwork: boolean
  readonly #localPeerId: Uint8Array

  constructor(options: PeerAdmissionPolicyOptions) {
    if (
      typeof options.allowPrivateNetwork !== 'boolean' ||
      !(options.localPeerId instanceof Uint8Array) ||
      options.localPeerId.byteLength !== PEER_ID_BYTES
    ) {
      throw new Error('Invalid peer admission policy')
    }
    this.#allowPrivateNetwork = options.allowPrivateNetwork
    this.#localPeerId = options.localPeerId.slice()
  }

  allows(candidate: PeerAdmissionCandidate): boolean {
    if (
      typeof candidate.address !== 'string' ||
      (!isPublicIpv4(candidate.address) &&
        !(this.#allowPrivateNetwork && isPrivateNetworkIpv4(candidate.address)))
    ) {
      return false
    }

    if (candidate.peerId === undefined) return true
    if (
      !(candidate.peerId instanceof Uint8Array) ||
      candidate.peerId.byteLength !== PEER_ID_BYTES
    ) {
      return false
    }

    let difference = 0
    for (let index = 0; index < PEER_ID_BYTES; index += 1) {
      difference |=
        (candidate.peerId[index] ?? 0) ^ (this.#localPeerId[index] ?? 0)
    }
    return difference !== 0
  }
}
