import WebSocket from 'ws'
import { EgressPolicy, EgressPolicyError } from './network-policy'
import type { WssSocket } from './wss-tracker'

export const WSS_SOCKET_LIMITS = Object.freeze({
  /** One 15-second monotonic deadline covers DNS, TCP, TLS, and upgrade. */
  handshakeMs: 15_000,
  maxMessageBytes: 131_072,
  /** Connecting plus open sockets, engine-wide. */
  maxSockets: 8,
  /** Connecting plus open sockets for one disk-backed torrent. */
  maxSocketsPerTorrent: 4
} as const)

export type WssSocketErrorCode =
  'ENDPOINT_REJECTED' | 'SOCKET_BUDGET_EXCEEDED' | 'TRANSPORT_CLOSED'

export class WssSocketError extends Error {
  readonly code: WssSocketErrorCode

  constructor(code: WssSocketErrorCode) {
    super(`WSS socket failed: ${code}.`)
    this.name = 'WssSocketError'
    this.code = code
  }
}

type SocketFactory = (
  url: string,
  options: Readonly<{
    handshakeTimeout: number
    host: string
    lookup: (
      hostname: string,
      options: unknown,
      callback: (error: Error | null, address: string, family: number) => void
    ) => void
    maxPayload: number
    origin: undefined
    perMessageDeflate: false
    servername: string
    minVersion: 'TLSv1.2'
    ALPNProtocols: ReadonlyArray<string>
    followRedirects: false
    headers: Readonly<Record<string, string>>
  }>
) => WssSocket

/**
 * Opens the one kind of WebSocket this release allows: a `wss:` tracker
 * socket, resolved and pinned by the egress policy, presenting its original
 * identity for TLS while connecting only to the approved address.
 *
 * Nothing is pooled, compressed, redirected, or reconnected, no ambient
 * credential or `Origin` is sent, and the engine-wide and per-torrent socket
 * budgets are held from the moment a connection starts until it closes.
 */
export class WssSocketFactory {
  readonly #create: SocketFactory
  readonly #open = new Map<string, number>()
  readonly #policy: EgressPolicy
  #total = 0

  constructor(
    options: Readonly<{
      createSocket?: SocketFactory
      policy: EgressPolicy
    }>
  ) {
    this.#create =
      options.createSocket ??
      ((url, socketOptions) =>
        new WebSocket(url, socketOptions as never) as unknown as WssSocket)
    this.#policy = options.policy
  }

  get openSocketCount(): number {
    return this.#total
  }

  socketCountFor(infoHash: string): number {
    return this.#open.get(infoHash) ?? 0
  }

  /**
   * Reserves a slot, resolves the endpoint, and connects. The slot is released
   * exactly once, whether the socket closes, errors, or never opened.
   */
  async connect(
    input: Readonly<{ infoHash: string; signal?: AbortSignal; url: string }>
  ): Promise<WssSocket> {
    if (this.#total >= WSS_SOCKET_LIMITS.maxSockets) {
      throw new WssSocketError('SOCKET_BUDGET_EXCEEDED')
    }
    if (
      this.socketCountFor(input.infoHash) >=
      WSS_SOCKET_LIMITS.maxSocketsPerTorrent
    ) {
      throw new WssSocketError('SOCKET_BUDGET_EXCEEDED')
    }

    this.#acquire(input.infoHash)
    let endpoint
    try {
      endpoint = await this.#policy.approveWssEndpoint(input.url, {
        ...(input.signal ? { signal: input.signal } : {})
      })
    } catch (error) {
      this.#release(input.infoHash)
      if (error instanceof EgressPolicyError) {
        throw new WssSocketError('ENDPOINT_REJECTED')
      }
      throw error
    }

    let socket: WssSocket
    try {
      socket = this.#create(endpoint.href, {
        ALPNProtocols: ['http/1.1'],
        followRedirects: false,
        handshakeTimeout: WSS_SOCKET_LIMITS.handshakeMs,
        headers: {},
        host: endpoint.hostname,
        // The address is already approved, so the socket never asks the
        // resolver again and cannot be rebound to a different host.
        lookup: (_hostname, _options, callback) => {
          callback(null, endpoint.address, 4)
        },
        maxPayload: WSS_SOCKET_LIMITS.maxMessageBytes,
        minVersion: 'TLSv1.2',
        origin: undefined,
        perMessageDeflate: false,
        servername: endpoint.hostname
      })
    } catch {
      this.#release(input.infoHash)
      throw new WssSocketError('TRANSPORT_CLOSED')
    }

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.#release(input.infoHash)
    }
    socket.on('close', release)
    socket.on('error', release)
    return socket
  }

  #acquire(infoHash: string): void {
    this.#total += 1
    this.#open.set(infoHash, this.socketCountFor(infoHash) + 1)
  }

  #release(infoHash: string): void {
    this.#total = Math.max(0, this.#total - 1)
    const next = this.socketCountFor(infoHash) - 1
    if (next <= 0) this.#open.delete(infoHash)
    else this.#open.set(infoHash, next)
  }
}
