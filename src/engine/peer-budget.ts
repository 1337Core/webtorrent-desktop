export const PEER_BUDGET_LIMITS = Object.freeze({
  /** Live peer transports engine-wide, TCP and WebRTC together. */
  maxLiveTransports: 55,
  /** Peer records engine-wide, across the public, private, and staging clients. */
  maxRecords: 256,
  /** Peer records one torrent may retain. */
  maxRecordsPerTorrent: 128,
  /** PEX-origin records engine-wide, a subset of the record budget. */
  maxPexRecords: 64,
  /** PEX-origin records one torrent may retain. */
  maxPexRecordsPerTorrent: 50,
  /** Live peer transports every staging acquisition may hold together. */
  maxStagingLiveTransports: 8,
  /** Peer records every staging acquisition may hold together. */
  maxStagingRecords: 32,
  /** Peer records one staging acquisition may retain. */
  maxStagingRecordsPerAcquisition: 16
} as const)

export type PeerBudgetScope = 'pex' | 'staging' | 'torrent'

export type PeerBudgetOptions = Readonly<{
  /**
   * Live peer transports the engine currently holds. It is read at admission
   * time rather than tracked here, so a transport that WebTorrent drops
   * returns its capacity without any bookkeeping to go stale.
   */
  liveTransports: () => number
  /** Live peer transports held by staging acquisitions only. */
  stagingLiveTransports?: () => number
}>

type Holder = {
  key: string
  /** PEX-origin peer keys, a subset of `records`. */
  pex: Set<string>
  /** Peer keys in least-recently-admitted order. */
  records: Map<string, () => void>
  scope: PeerBudgetScope
  /** Capacity reserved immediately before a peer is handed to WebTorrent. */
  transports: Map<string, PeerTransportLease>
}

export type PeerTransportLease = Readonly<{
  release: () => void
}>

/**
 * The engine-wide peer-admission budget.
 *
 * WebTorrent enforces `maxConns` per torrent, which bounds nothing across two
 * clients and many torrents. This is the shared bound: every peer the engine
 * hands to WebTorrent — discovered address or signaled transport — passes here
 * first, so no single torrent can drain the engine's capacity.
 *
 * Capacity is shared round-robin: when the engine-wide record budget is full,
 * the torrent holding the most records gives up its oldest one, so a busy
 * torrent cannot starve a quiet one.
 */
export class PeerBudget {
  readonly #holders = new Map<string, Holder>()
  readonly #liveTransports: () => number
  readonly #stagingLiveTransports: () => number

  constructor(options: PeerBudgetOptions) {
    this.#liveTransports = options.liveTransports
    this.#stagingLiveTransports = options.stagingLiveTransports ?? (() => 0)
  }

  get recordCount(): number {
    let total = 0
    for (const holder of this.#holders.values()) total += holder.records.size
    return total
  }

  recordsFor(key: string): number {
    return this.#holders.get(key)?.records.size ?? 0
  }

  get reservedTransportCount(): number {
    let total = 0
    for (const holder of this.#holders.values()) total += holder.transports.size
    return total
  }

  /**
   * Reserves aggregate live-transport capacity immediately before handoff.
   * The reservation closes the sampling race between concurrent torrents;
   * callers release a rejected handoff immediately and accepted handoffs when
   * their peer record or whole generation is retired.
   */
  reserveTransport(
    input: Readonly<{ key: string; peer: string; scope?: PeerBudgetScope }>
  ): PeerTransportLease | null {
    const scope = input.scope ?? 'torrent'
    const holder = this.#holder(input.key, scope)
    if (holder.transports.has(input.peer)) return null
    if (!this.#admitsTransport(scope)) return null

    let released = false
    const lease: PeerTransportLease = {
      release: () => {
        if (released) return
        released = true
        if (holder.transports.get(input.peer) === lease) {
          holder.transports.delete(input.peer)
        }
      }
    }
    holder.transports.set(input.peer, lease)
    return lease
  }

  /**
   * Admits one peer for a holder, recording it. A peer already recorded is
   * admitted again without consuming further capacity, which keeps a repeated
   * discovery from counting twice.
   */
  admit(
    input: Readonly<{
      key: string
      peer: string
      remove?: () => void
      scope?: PeerBudgetScope
    }>
  ): boolean {
    const scope = input.scope ?? 'torrent'
    const holder = this.#holder(input.key, scope)
    if (holder.records.has(input.peer)) return true
    if (!this.#admitsTransport(scope)) return false
    if (scope === 'pex' && !this.#admitsPex(holder)) return false
    if (!this.#admitsRecord(holder, scope)) return false

    holder.records.set(input.peer, input.remove ?? (() => undefined))
    if (scope === 'pex') holder.pex.add(input.peer)
    return true
  }

  /** Drops one holder's records, returning their capacity to the engine. */
  release(key: string): void {
    const holder = this.#holders.get(key)
    if (!holder) return
    for (const lease of holder.transports.values()) lease.release()
    this.#holders.delete(key)
  }

  /** Drops one recorded peer, typically when its transport is gone. */
  forget(key: string, peer: string): void {
    const holder = this.#holders.get(key)
    holder?.transports.get(peer)?.release()
    holder?.records.delete(peer)
    holder?.pex.delete(peer)
  }

  has(key: string, peer: string): boolean {
    return this.#holders.get(key)?.records.has(peer) ?? false
  }

  pexRecordsFor(key: string): number {
    return this.#holders.get(key)?.pex.size ?? 0
  }

  /**
   * PEX is a receive-only discovery source with its own narrower ceiling
   * inside the shared record budget, so a talkative swarm cannot fill the
   * engine through it.
   */
  #admitsPex(holder: Holder): boolean {
    if (holder.pex.size >= PEER_BUDGET_LIMITS.maxPexRecordsPerTorrent) {
      return false
    }
    let total = 0
    for (const entry of this.#holders.values()) total += entry.pex.size
    return total < PEER_BUDGET_LIMITS.maxPexRecords
  }

  #holder(key: string, scope: PeerBudgetScope): Holder {
    const existing = this.#holders.get(key)
    if (existing) return existing
    const holder: Holder = {
      key,
      pex: new Set(),
      records: new Map(),
      scope,
      transports: new Map()
    }
    this.#holders.set(key, holder)
    return holder
  }

  #admitsTransport(scope: PeerBudgetScope): boolean {
    if (
      this.#liveTransports() + this.reservedTransportCount >=
      PEER_BUDGET_LIMITS.maxLiveTransports
    ) {
      return false
    }
    let stagingReserved = 0
    for (const holder of this.#holders.values()) {
      if (holder.scope === 'staging') {
        stagingReserved += holder.transports.size
      }
    }
    return (
      scope !== 'staging' ||
      this.#stagingLiveTransports() + stagingReserved <
        PEER_BUDGET_LIMITS.maxStagingLiveTransports
    )
  }

  #admitsRecord(holder: Holder, scope: PeerBudgetScope): boolean {
    const perHolder =
      scope === 'staging'
        ? PEER_BUDGET_LIMITS.maxStagingRecordsPerAcquisition
        : PEER_BUDGET_LIMITS.maxRecordsPerTorrent

    if (holder.records.size >= perHolder) return false

    if (
      scope === 'staging' &&
      this.#stagingRecords() >= PEER_BUDGET_LIMITS.maxStagingRecords
    ) {
      return false
    }
    if (this.recordCount < PEER_BUDGET_LIMITS.maxRecords) return true

    // The engine is full: take one record back from the largest holder rather
    // than refusing the quiet torrent that is asking.
    return this.#evictLargest(holder)
  }

  #stagingRecords(): number {
    let total = 0
    for (const holder of this.#holders.values()) {
      if (holder.scope === 'staging') total += holder.records.size
    }
    return total
  }

  #evictLargest(requesting: Holder): boolean {
    let largest: Holder | null = null
    for (const holder of this.#holders.values()) {
      if (!largest || holder.records.size > largest.records.size) {
        largest = holder
      }
    }
    // A holder never funds its own growth by evicting itself unless it is the
    // only one holding records.
    if (!largest || largest.records.size === 0) return false
    if (largest === requesting && this.#holders.size > 1) return false

    const oldest = largest.records.entries().next().value as
      [string, () => void] | undefined
    if (!oldest) return false
    const [peer, remove] = oldest
    try {
      remove()
    } catch {
      return false
    }
    largest.transports.get(peer)?.release()
    largest.records.delete(peer)
    largest.pex.delete(peer)
    return true
  }
}
