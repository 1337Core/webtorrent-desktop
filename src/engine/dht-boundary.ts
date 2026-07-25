import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import bencode from 'bencode'
import {
  decodeDhtDatagram,
  DhtIngressLimiter,
  DhtTransactionIds,
  DhtWireError,
  DHT_WIRE_LIMITS,
  sanitizeCompactNodes,
  sanitizeCompactPeers,
  type CompactNode,
  type CompactPeer,
  type KrpcValue
} from './dht-wire'
import { isPublicIpv4 } from './network-policy'

export const DHT_BOUNDARY_LIMITS = Object.freeze({
  bootstrapAddressesPerHost: 2,
  bootstrapDeadlineMs: 5_000,
  bootstrapTotalAddresses: 6,
  concurrentOperations: 2,
  failureBackoffMaxMs: 15 * 60_000,
  failureBackoffMinMs: 60_000,
  maxAnnounceTargets: 20,
  maxNodeQueriesPerCycle: 64,
  maxPeerObservations: 256,
  maxPeersPerResponse: 100,
  maxPendingQueries: 64,
  maxQueuedActivations: 64,
  maxRoutingContacts: 1_024,
  queryConcurrency: 8,
  queryTimeoutMs: 2_000,
  refreshIntervalMs: 15 * 60_000,
  refreshJitterMs: 3 * 60_000
})

/** The reviewed bootstrap endpoints; nothing else is ever contacted. */
export const DHT_BOOTSTRAP_ENDPOINTS: ReadonlyArray<
  Readonly<{ hostname: string; port: number }>
> = Object.freeze([
  { hostname: 'router.bittorrent.com', port: 6881 },
  { hostname: 'router.utorrent.com', port: 6881 },
  { hostname: 'dht.transmissionbt.com', port: 6881 }
])

export type DhtBoundaryErrorCode =
  | 'BOOTSTRAP_UNAVAILABLE'
  | 'CLOSED'
  | 'GENERATION_CONFLICT'
  | 'PRIVATE_TORRENT'
  | 'QUEUE_FULL'

export class DhtBoundaryError extends Error {
  readonly code: DhtBoundaryErrorCode

  constructor(code: DhtBoundaryErrorCode) {
    super(`DHT boundary rejected the operation: ${code}.`)
    this.name = 'DhtBoundaryError'
    this.code = code
  }
}

/** The exact `node:dgram` surface the boundary uses. */
export type DhtSocket = {
  bind(port: number, callback?: () => void): void
  close(callback?: () => void): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  send(
    message: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null) => void
  ): void
}

export type DhtBoundaryOptions = Readonly<{
  createSocket?: () => DhtSocket
  now?: () => number
  onPeers?: (delivery: DhtPeerDelivery) => void
  onWarning?: (code: 'DHT_UNAVAILABLE') => void
  /** Bounded IPv4 resolution; the boundary passes only numeric literals on. */
  resolveBootstrap?: (hostname: string) => Promise<ReadonlyArray<string>>
  sessionNodeId?: Uint8Array
}>

export type DhtPeerDelivery = Readonly<{
  generationId: string
  infoHash: string
  peers: ReadonlyArray<CompactPeer>
}>

type PendingQuery = {
  address: string
  expectedTransaction: number
  port: number
  settle: (response: Map<string, KrpcValue> | null) => void
  timer: NodeJS.Timeout
}

type Activation = {
  announcePort: number
  generationId: string
  infoHash: string
  running: boolean
  timer: NodeJS.Timeout | null
  failureRound: number
}

function infoHashBytes(infoHash: string): Uint8Array {
  const bytes = new Uint8Array(20)
  for (let index = 0; index < 20; index += 1) {
    bytes[index] = Number.parseInt(infoHash.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function contactKey(address: string, port: number): string {
  return `${address}:${port}`
}

/**
 * The engine's only DHT participant: public torrents and explicitly consented
 * metadata staging, nothing else.
 *
 * It is created lazily on the first activation and destroyed when the last one
 * closes, so an empty launch, a private-only session, and a paused public
 * torrent all send zero packets. Every datagram crosses the bounded wire
 * boundary, and every query is matched on exact source address, source port,
 * and a randomized unused transaction identifier.
 */
export class DhtBoundary {
  readonly #activations = new Map<string, Activation>()
  readonly #createSocket: () => DhtSocket
  readonly #ingress: DhtIngressLimiter
  readonly #nodeId: Uint8Array
  readonly #now: () => number
  readonly #onPeers: (delivery: DhtPeerDelivery) => void
  readonly #onWarning: (code: 'DHT_UNAVAILABLE') => void
  readonly #pending = new Map<number, PendingQuery>()
  readonly #resolveBootstrap: (
    hostname: string
  ) => Promise<ReadonlyArray<string>>
  readonly #routing = new Map<string, CompactNode>()
  readonly #transactions = new DhtTransactionIds()
  #bootstrapped: ReadonlyArray<CompactPeer> = []
  #closed = false
  #socket: DhtSocket | null = null

  constructor(options: DhtBoundaryOptions = {}) {
    this.#createSocket =
      options.createSocket ??
      (() => createSocket({ reuseAddr: false, type: 'udp4' }) as DhtSocket)
    this.#now = options.now ?? (() => Date.now())
    this.#ingress = new DhtIngressLimiter(this.#now)
    this.#nodeId = options.sessionNodeId?.slice() ?? randomBytes(20)
    this.#onPeers = options.onPeers ?? (() => undefined)
    this.#onWarning = options.onWarning ?? (() => undefined)
    this.#resolveBootstrap =
      options.resolveBootstrap ?? (() => Promise.resolve([]))
  }

  get active(): boolean {
    return this.#socket !== null
  }

  get activationCount(): number {
    return this.#activations.size
  }

  get routingSize(): number {
    return this.#routing.size
  }

  /**
   * Starts a bounded discovery cycle for one committed public generation. A
   * private torrent never enters the scheduler.
   */
  async activate(
    input: Readonly<{
      announcePort: number
      generationId: string
      infoHash: string
      private: boolean
    }>
  ): Promise<void> {
    if (this.#closed) throw new DhtBoundaryError('CLOSED')
    if (input.private) throw new DhtBoundaryError('PRIVATE_TORRENT')
    const existing = this.#activations.get(input.infoHash)
    if (existing) {
      if (existing.generationId === input.generationId) return
      throw new DhtBoundaryError('GENERATION_CONFLICT')
    }
    if (this.#activations.size >= DHT_BOUNDARY_LIMITS.maxQueuedActivations) {
      throw new DhtBoundaryError('QUEUE_FULL')
    }

    this.#activations.set(input.infoHash, {
      announcePort: input.announcePort,
      failureRound: 0,
      generationId: input.generationId,
      infoHash: input.infoHash,
      running: false,
      timer: null
    })
    await this.#ensureSocket()
    await this.#runCycle(input.infoHash)
  }

  /** Closes a generation: its queued work, timers, and late callbacks drop. */
  deactivate(infoHash: string, generationId?: string): void {
    const activation = this.#activations.get(infoHash)
    if (!activation) return
    if (generationId && activation.generationId !== generationId) return
    if (activation.timer) clearTimeout(activation.timer)
    this.#activations.delete(infoHash)
    if (this.#activations.size === 0) this.#teardown()
  }

  /** Drains every pending callback exactly once and closes the socket. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const infoHash of [...this.#activations.keys()]) {
      const activation = this.#activations.get(infoHash)
      if (activation?.timer) clearTimeout(activation.timer)
    }
    this.#activations.clear()
    this.#teardown()
  }

  async #ensureSocket(): Promise<void> {
    if (this.#socket || this.#closed) return

    const socket = this.#createSocket()
    this.#socket = socket
    socket.on('message', (...args: unknown[]) => {
      const [message, remote] = args
      if (!(message instanceof Uint8Array)) return
      if (typeof remote !== 'object' || remote === null) return
      const { address, port } = remote as { address?: unknown; port?: unknown }
      if (typeof address !== 'string' || typeof port !== 'number') return
      this.#receive(message, { address, port })
    })
    socket.on('error', () => {
      this.#teardown()
      this.#onWarning('DHT_UNAVAILABLE')
    })
    socket.bind(0)

    if (this.#bootstrapped.length === 0) {
      this.#bootstrapped = await this.#resolveBootstrapEndpoints()
    }
    if (this.#bootstrapped.length === 0) {
      this.#onWarning('DHT_UNAVAILABLE')
    }
  }

  #teardown(): void {
    // Settle first: the resolver itself removes the entry and releases the
    // identifier, so every waiter completes exactly once.
    for (const [id, pending] of [...this.#pending]) {
      pending.settle(null)
      this.#pending.delete(id)
      this.#transactions.release(id)
    }
    this.#routing.clear()
    const socket = this.#socket
    this.#socket = null
    if (!socket) return
    try {
      socket.close()
    } catch {
      // A socket already closed by an error path needs no further action.
    }
  }

  /**
   * Resolves the reviewed hostnames to numeric IPv4 literals under one
   * deadline, keeping at most two addresses per host and six overall. DHT
   * routing never receives the RFC 1918 exception.
   */
  async #resolveBootstrapEndpoints(): Promise<ReadonlyArray<CompactPeer>> {
    const deadline = new Promise<ReadonlyArray<string>>(resolve => {
      const timer = setTimeout(
        () => resolve([]),
        DHT_BOUNDARY_LIMITS.bootstrapDeadlineMs
      )
      timer.unref()
    })

    const endpoints: CompactPeer[] = []
    for (const endpoint of DHT_BOOTSTRAP_ENDPOINTS) {
      if (endpoints.length >= DHT_BOUNDARY_LIMITS.bootstrapTotalAddresses) break
      let addresses: ReadonlyArray<string>
      try {
        addresses = await Promise.race([
          this.#resolveBootstrap(endpoint.hostname),
          deadline
        ])
      } catch {
        continue
      }
      let kept = 0
      for (const address of addresses) {
        if (
          kept >= DHT_BOUNDARY_LIMITS.bootstrapAddressesPerHost ||
          endpoints.length >= DHT_BOUNDARY_LIMITS.bootstrapTotalAddresses
        ) {
          break
        }
        if (!isPublicIpv4(address)) continue
        endpoints.push({ address, port: endpoint.port })
        kept += 1
      }
    }
    return endpoints
  }

  async #runCycle(infoHash: string): Promise<void> {
    const activation = this.#activations.get(infoHash)
    if (!activation || activation.running || this.#closed) return
    if (
      [...this.#activations.values()].filter(entry => entry.running).length >=
      DHT_BOUNDARY_LIMITS.concurrentOperations
    ) {
      this.#schedule(activation, 1_000)
      return
    }

    const generationId = activation.generationId
    if (!this.#socket) {
      try {
        await this.#ensureSocket()
      } catch {
        // Socket construction is retried through the same bounded backoff as
        // an unanswered discovery cycle.
      }
      if (this.#generationClosed(infoHash, generationId)) return
      if (!this.#socket) {
        activation.failureRound += 1
        this.#onWarning('DHT_UNAVAILABLE')
        this.#schedule(activation, this.#backoffMs(activation.failureRound))
        return
      }
    }

    activation.running = true
    const target = infoHashBytes(infoHash)
    const observed = new Map<string, CompactPeer>()
    const tokens: Array<{ node: CompactPeer; token: Uint8Array }> = []
    const visited = new Set<string>()
    let queries = 0
    let answered = 0

    let frontier = [...this.#bootstrapped, ...this.#routing.values()].map(
      node => ({ address: node.address, port: node.port })
    )

    while (
      frontier.length > 0 &&
      queries < DHT_BOUNDARY_LIMITS.maxNodeQueriesPerCycle &&
      observed.size < DHT_BOUNDARY_LIMITS.maxPeerObservations
    ) {
      const batch = frontier.splice(0, DHT_BOUNDARY_LIMITS.queryConcurrency)
      const responses = await Promise.all(
        batch.map(node => {
          const key = contactKey(node.address, node.port)
          if (visited.has(key)) return Promise.resolve(null)
          visited.add(key)
          queries += 1
          return this.#query(node, 'get_peers', { info_hash: target })
        })
      )
      if (this.#generationClosed(infoHash, generationId)) break

      for (const [index, response] of responses.entries()) {
        const node = batch[index]
        if (!response || !node) continue
        answered += 1
        this.#observe(node.address, node.port)

        for (const peer of sanitizeCompactPeers(
          response.get('values') as ReadonlyArray<KrpcValue> | undefined,
          DHT_BOUNDARY_LIMITS.maxPeersPerResponse
        )) {
          if (observed.size >= DHT_BOUNDARY_LIMITS.maxPeerObservations) break
          observed.set(contactKey(peer.address, peer.port), peer)
        }

        const token = response.get('token')
        if (
          token instanceof Uint8Array &&
          tokens.length < DHT_BOUNDARY_LIMITS.maxAnnounceTargets
        ) {
          tokens.push({ node, token })
        }

        for (const discovered of sanitizeCompactNodes(
          response.get('nodes') as Uint8Array | undefined
        )) {
          this.#insertContact(discovered)
          if (!visited.has(contactKey(discovered.address, discovered.port))) {
            frontier.push({
              address: discovered.address,
              port: discovered.port
            })
          }
        }
      }
      frontier = frontier.slice(0, DHT_BOUNDARY_LIMITS.maxNodeQueriesPerCycle)
    }

    if (!this.#generationClosed(infoHash, generationId)) {
      if (observed.size > 0) {
        this.#onPeers({
          generationId,
          infoHash,
          peers: [...observed.values()]
        })
      }
      this.#announce(target, tokens, activation.announcePort)
    }

    const current = this.#activations.get(infoHash)
    if (!current || current.generationId !== generationId) return
    current.running = false
    if (answered === 0) {
      current.failureRound += 1
      this.#onWarning('DHT_UNAVAILABLE')
      this.#schedule(current, this.#backoffMs(current.failureRound))
      return
    }
    current.failureRound = 0
    this.#schedule(current, this.#refreshDelayMs(infoHash))
  }

  /**
   * Announces to the token-bearing nodes without waiting for their replies: a
   * lost announce response is not a cycle failure, and the caller's activation
   * must not block on remote timeouts.
   */
  #announce(
    target: Uint8Array,
    tokens: ReadonlyArray<{ node: CompactPeer; token: Uint8Array }>,
    announcePort: number
  ): void {
    if (announcePort < 1 || announcePort > 65_535) return
    for (const entry of tokens.slice(
      0,
      DHT_BOUNDARY_LIMITS.maxAnnounceTargets
    )) {
      void this.#query(entry.node, 'announce_peer', {
        implied_port: 0,
        info_hash: target,
        port: announcePort,
        token: entry.token
      })
    }
  }

  #generationClosed(infoHash: string, generationId: string): boolean {
    if (this.#closed) return true
    const activation = this.#activations.get(infoHash)
    return !activation || activation.generationId !== generationId
  }

  #schedule(activation: Activation, delayMs: number): void {
    if (this.#closed) return
    if (activation.timer) clearTimeout(activation.timer)
    const timer = setTimeout(() => {
      activation.timer = null
      void this.#runCycle(activation.infoHash)
    }, delayMs)
    timer.unref()
    activation.timer = timer
  }

  #refreshDelayMs(infoHash: string): number {
    let sum = 0
    for (let index = 0; index < infoHash.length; index += 1) {
      sum = (sum * 31 + infoHash.charCodeAt(index)) % 1_000_003
    }
    return (
      DHT_BOUNDARY_LIMITS.refreshIntervalMs +
      (sum % DHT_BOUNDARY_LIMITS.refreshJitterMs)
    )
  }

  #backoffMs(round: number): number {
    return Math.min(
      DHT_BOUNDARY_LIMITS.failureBackoffMinMs * 2 ** Math.max(round - 1, 0),
      DHT_BOUNDARY_LIMITS.failureBackoffMaxMs
    )
  }

  /** Guarded insertion: refresh known public contacts, cap new ones. */
  #insertContact(node: CompactNode): void {
    const key = contactKey(node.address, node.port)
    if (this.#routing.has(key)) {
      this.#routing.delete(key)
      this.#routing.set(key, node)
      return
    }
    if (this.#routing.size >= DHT_BOUNDARY_LIMITS.maxRoutingContacts) return
    this.#routing.set(key, node)
  }

  #observe(address: string, port: number): void {
    this.#insertContact({ address, id: new Uint8Array(20), port })
  }

  #query(
    node: CompactPeer,
    method: 'announce_peer' | 'find_node' | 'get_peers' | 'ping',
    args: Record<string, unknown>
  ): Promise<Map<string, KrpcValue> | null> {
    const socket = this.#socket
    if (
      !socket ||
      this.#closed ||
      this.#pending.size >= DHT_BOUNDARY_LIMITS.maxPendingQueries ||
      !isPublicIpv4(node.address)
    ) {
      return Promise.resolve(null)
    }

    const transaction = this.#transactions.allocate()
    const datagram: Uint8Array = bencode.encode({
      a: { id: this.#nodeId, ...args },
      q: method,
      t: new Uint8Array([(transaction >> 8) & 0xff, transaction & 0xff]),
      y: 'q'
    })
    if (datagram.byteLength > DHT_WIRE_LIMITS.maxDatagramBytes) {
      this.#transactions.release(transaction)
      return Promise.resolve(null)
    }

    return new Promise<Map<string, KrpcValue> | null>(resolve => {
      const settle = (response: Map<string, KrpcValue> | null): void => {
        if (!this.#pending.has(transaction)) return
        this.#pending.delete(transaction)
        this.#transactions.release(transaction)
        resolve(response)
      }
      const timer = setTimeout(() => {
        // An explicit timeout also removes the dead contact before later
        // inserts, so a stale entry cannot occupy the routing cap.
        this.#routing.delete(contactKey(node.address, node.port))
        settle(null)
      }, DHT_BOUNDARY_LIMITS.queryTimeoutMs)
      timer.unref()
      this.#pending.set(transaction, {
        address: node.address,
        expectedTransaction: transaction,
        port: node.port,
        settle: response => {
          clearTimeout(timer)
          settle(response)
        },
        timer
      })

      try {
        socket.send(datagram, node.port, node.address, error => {
          if (error) this.#pending.get(transaction)?.settle(null)
        })
      } catch {
        this.#pending.get(transaction)?.settle(null)
      }
    })
  }

  #receive(
    message: Uint8Array,
    remote: Readonly<{ address: string; port: number }>
  ): void {
    if (this.#closed || !this.#ingress.accept(remote.address)) return

    let decoded
    try {
      decoded = decodeDhtDatagram(message)
    } catch (error) {
      if (!(error instanceof DhtWireError)) throw error
      return
    }
    if (decoded.kind !== 'response') return
    if (decoded.transactionId.byteLength !== 2) return

    const transaction =
      (((decoded.transactionId[0] as number) << 8) |
        (decoded.transactionId[1] as number)) &
      0xff_ff
    const pending = this.#pending.get(transaction)
    if (
      !pending ||
      pending.address !== remote.address ||
      pending.port !== remote.port
    ) {
      return
    }
    pending.settle(decoded.response)
  }
}
