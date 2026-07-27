import bencode from 'bencode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EgressPolicy, EgressPolicyError } from './network-policy'
import { PeerAdmissionPolicy } from './peer-admission'
import {
  parseTrackerAnnounceResponse as parseTrackerAnnounceResponseWithAdmission,
  TRACKER_HTTP_EGRESS_PROFILE,
  TrackerHttpError,
  TrackerHttpRequestGate,
  TrackerHttpTransport,
  type TrackerAnnounceInput,
  type TrackerHttpEgress,
  type TrackerHttpFetchResult
} from './tracker-http'

const urlPolicy = new EgressPolicy()
const parserLocalPeerId = new Uint8Array(20).fill(42)

function validResponse(overrides: Record<string, unknown> = {}): Uint8Array {
  return bencode.encode({
    interval: 1_800,
    peers: new Uint8Array(),
    ...overrides
  })
}

function parseTrackerAnnounceResponse(
  bytes: Uint8Array,
  options: Readonly<{
    allowPrivateNetwork?: boolean
    localPeerId?: Uint8Array
  }> = {}
) {
  return parseTrackerAnnounceResponseWithAdmission(
    bytes,
    new PeerAdmissionPolicy({
      allowPrivateNetwork: options.allowPrivateNetwork ?? true,
      localPeerId: options.localPeerId ?? parserLocalPeerId
    })
  )
}

function announceInput(
  overrides: Partial<TrackerAnnounceInput> = {}
): TrackerAnnounceInput {
  return {
    allowHttp: false,
    allowPrivateNetwork: false,
    downloaded: 0,
    infoHash: Uint8Array.from({ length: 20 }, (_value, index) => index),
    left: 10,
    peerId: Uint8Array.from({ length: 20 }, (_value, index) => 255 - index),
    port: 6_881,
    trackerUrl: 'https://tracker.example/announce?passkey=opaque',
    uploaded: 0,
    ...overrides
  }
}

function createEgress(
  fetchTrackerResponse: TrackerHttpEgress['fetchTrackerResponse']
): TrackerHttpEgress {
  return {
    fetchTrackerResponse,
    validateTrackerUrl: value => urlPolicy.validateTrackerUrl(value)
  }
}

function createTransport(
  fetchTrackerResponse: TrackerHttpEgress['fetchTrackerResponse'],
  requestGate = new TrackerHttpRequestGate(2),
  now?: () => number
): TrackerHttpTransport {
  return new TrackerHttpTransport({
    egress: createEgress(fetchTrackerResponse),
    now,
    requestGate
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('TrackerHttpTransport announce requests', () => {
  it('builds one compact announce with binary fields and fixed numwant', async () => {
    let requestedUrl = ''
    const transport = createTransport(async value => {
      requestedUrl = value
      return { bytes: validResponse() }
    })

    await transport.announce(
      announceInput({
        downloaded: 22,
        event: 'started',
        left: 33,
        trackerId: Uint8Array.of(0, 255),
        uploaded: 11
      })
    )

    const parsed = new URL(requestedUrl)
    expect(parsed.origin).toBe('https://tracker.example')
    expect(parsed.searchParams.get('passkey')).toBe('opaque')
    expect(parsed.searchParams.get('port')).toBe('6881')
    expect(parsed.searchParams.get('uploaded')).toBe('11')
    expect(parsed.searchParams.get('downloaded')).toBe('22')
    expect(parsed.searchParams.get('left')).toBe('33')
    expect(parsed.searchParams.get('compact')).toBe('1')
    expect(parsed.searchParams.get('no_peer_id')).toBe('1')
    expect(parsed.searchParams.get('numwant')).toBe('50')
    expect(parsed.searchParams.get('event')).toBe('started')
    expect(requestedUrl).toContain(
      'info_hash=%00%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13'
    )
    expect(requestedUrl).toContain(
      'peer_id=%FF%FE%FD%FC%FB%FA%F9%F8%F7%F6%F5%F4%F3%F2%F1%F0%EF%EE%ED%EC'
    )
    expect(requestedUrl).toContain('trackerid=%00%FF')
  })

  it('rejects disabled transports, insecure HTTP, and ambiguous query fields', async () => {
    const fetchTrackerResponse =
      vi.fn<TrackerHttpEgress['fetchTrackerResponse']>()
    const transport = createTransport(fetchTrackerResponse)

    await expect(
      transport.announce(
        announceInput({ trackerUrl: 'http://tracker.example/announce' })
      )
    ).rejects.toMatchObject({ code: 'HTTP_DISABLED' })
    for (const trackerUrl of [
      'udp://tracker.example:6969/announce',
      'ws://tracker.example/announce',
      'wss://tracker.example/announce'
    ]) {
      await expect(
        transport.announce(announceInput({ trackerUrl }))
      ).rejects.toMatchObject({ code: 'TRANSPORT_DISABLED' })
    }
    await expect(
      transport.announce(
        announceInput({
          trackerUrl: 'https://tracker.example/announce?info_hash=shadow'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(
      transport.announce(
        announceInput({
          trackerUrl: 'https://user:secret@tracker.example/announce'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchTrackerResponse).not.toHaveBeenCalled()
  })

  it('uses one explicitly shared gate across transport instances', async () => {
    let finishFirst: ((result: TrackerHttpFetchResult) => void) | undefined
    const firstFetch = vi.fn(
      async () =>
        await new Promise<TrackerHttpFetchResult>(resolve => {
          finishFirst = resolve
        })
    )
    const gate = new TrackerHttpRequestGate(1)
    const firstTransport = createTransport(firstFetch, gate)
    const secondTransport = createTransport(
      async () => ({ bytes: validResponse() }),
      gate
    )

    const first = firstTransport.announce(announceInput())
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce())
    await expect(
      secondTransport.announce(announceInput())
    ).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' })

    finishFirst?.({ bytes: validResponse() })
    await expect(first).resolves.toMatchObject({ interval: 1_800 })
    expect(gate.active).toBe(0)
  })

  it('defaults the shared request gate to the fixed global limit', async () => {
    const gate = new TrackerHttpRequestGate()
    const releases: Array<() => void> = []
    const active = Array.from({ length: 8 }, () =>
      gate.run(
        async () =>
          await new Promise<void>(resolve => {
            releases.push(resolve)
          })
      )
    )

    expect(gate.active).toBe(TRACKER_HTTP_EGRESS_PROFILE.globalConcurrency)
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT'
    })

    for (const release of releases) release()
    await Promise.all(active)
    expect(gate.active).toBe(0)
  })

  it('enforces an absolute deadline without releasing an ignored fetch', async () => {
    vi.useFakeTimers()
    let finishFetch: ((result: TrackerHttpFetchResult) => void) | undefined
    const fetchTrackerResponse = vi.fn(
      async () =>
        await new Promise<TrackerHttpFetchResult>(resolve => {
          finishFetch = resolve
        })
    )
    const gate = new TrackerHttpRequestGate(1)
    const transport = createTransport(fetchTrackerResponse, gate)

    const announce = transport.announce(announceInput())
    const timedOut = expect(announce).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(
      TRACKER_HTTP_EGRESS_PROFILE.absoluteDeadlineMs
    )
    await timedOut

    expect(gate.active).toBe(1)
    await expect(transport.announce(announceInput())).rejects.toMatchObject({
      code: 'CONCURRENCY_LIMIT'
    })
    finishFetch?.({ bytes: validResponse() })
    await vi.waitFor(() => expect(gate.active).toBe(0))
  })

  it('lets caller cancellation win when a fetch resolves in the same turn', async () => {
    const controller = new AbortController()
    const transport = createTransport(async () => {
      controller.abort()
      return { bytes: validResponse() }
    })

    await expect(
      transport.announce(announceInput({ signal: controller.signal }))
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('rejects success observed after the monotonic absolute deadline', async () => {
    let now = 1_000
    const transport = createTransport(
      async () => {
        now += TRACKER_HTTP_EGRESS_PROFILE.absoluteDeadlineMs
        return { bytes: validResponse() }
      },
      new TrackerHttpRequestGate(1),
      () => now
    )

    await expect(transport.announce(announceInput())).rejects.toMatchObject({
      code: 'TIMEOUT'
    })
  })

  it('maps network failures to path-free errors and enforces the body cap', async () => {
    const secret =
      'https://tracker.example/private-passkey?info_hash=do-not-leak'
    const failed = createTransport(async () => {
      throw new Error(secret)
    })
    const failure = await failed.announce(announceInput()).catch(error => error)

    expect(failure).toBeInstanceOf(TrackerHttpError)
    expect(failure).toMatchObject({ code: 'NETWORK_FAILED' })
    expect(String(failure)).not.toContain(secret)

    const oversized = createTransport(async () => ({
      bytes: new Uint8Array(TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes + 1)
    }))
    await expect(oversized.announce(announceInput())).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE'
    })
  })

  it('filters tracker-returned peer targets through private-network consent', async () => {
    const peers = Uint8Array.of(
      8,
      8,
      8,
      8,
      0x1a,
      0xe1,
      10,
      0,
      0,
      1,
      0x1a,
      0xe2,
      192,
      168,
      1,
      2,
      0x1a,
      0xe3,
      127,
      0,
      0,
      1,
      0x1a,
      0xe4,
      169,
      254,
      1,
      1,
      0x1a,
      0xe5,
      100,
      64,
      0,
      1,
      0x1a,
      0xe6
    )
    const transport = createTransport(async () => ({
      bytes: validResponse({ peers })
    }))

    await expect(transport.announce(announceInput())).resolves.toMatchObject({
      peers: [{ address: '8.8.8.8', family: 4, port: 6_881 }]
    })
    await expect(
      transport.announce(announceInput({ allowPrivateNetwork: true }))
    ).resolves.toMatchObject({
      peers: [
        { address: '8.8.8.8', family: 4, port: 6_881 },
        { address: '10.0.0.1', family: 4, port: 6_882 },
        { address: '192.168.1.2', family: 4, port: 6_883 }
      ]
    })
  })

  it.each([
    ['ABORTED', 'ABORTED'],
    ['BODY_TOO_LARGE', 'BODY_TOO_LARGE'],
    ['CONCURRENCY_LIMIT', 'CONCURRENCY_LIMIT'],
    ['HTTP_DISABLED', 'HTTP_DISABLED'],
    ['REQUEST_TIMEOUT', 'TIMEOUT'],
    ['DNS_FAILED', 'NETWORK_FAILED'],
    ['HTTP_STATUS', 'NETWORK_FAILED'],
    ['REDIRECT_BLOCKED', 'NETWORK_FAILED']
  ] as const)(
    'maps egress policy %s to the sanitized tracker error %s',
    async (policyCode, trackerCode) => {
      const transport = createTransport(async () => {
        throw new EgressPolicyError(policyCode)
      })

      const failure = await transport
        .announce(announceInput())
        .catch(error => error)

      expect(failure).toBeInstanceOf(TrackerHttpError)
      expect(failure).toMatchObject({ code: trackerCode })
      expect(String(failure)).toBe(
        `TrackerHttpError: Tracker HTTP announce failed: ${trackerCode}.`
      )
    }
  )

  it('publishes the fixed egress contract for the policy implementation', () => {
    expect(TRACKER_HTTP_EGRESS_PROFILE).toEqual({
      absoluteDeadlineMs: 15_000,
      globalConcurrency: 8,
      headers: {
        accept:
          'application/x-bittorrent, text/plain;q=0.9, application/octet-stream;q=0.8',
        'accept-encoding': 'identity',
        'cache-control': 'no-store',
        'user-agent':
          'WebTorrent Updated/1.0.0-dev (+https://github.com/1337Core/webtorrent-desktop)'
      },
      maxAcceptedPeers: 82,
      maxAnnounceIntervalSeconds: 86_400,
      maxRedirects: 3,
      maxResponseBytes: 1_048_576,
      minAnnounceIntervalSeconds: 60,
      requestedPeers: 50
    })
    expect(Object.isFrozen(TRACKER_HTTP_EGRESS_PROFILE.headers)).toBe(true)
  })
})

describe('parseTrackerAnnounceResponse', () => {
  it('parses IPv4 peers and validates but ignores unsupported IPv6 peers', () => {
    const peers = Uint8Array.of(1, 2, 3, 4, 0x1a, 0xe1)
    const peers6 = Uint8Array.of(
      0x20,
      0x01,
      0x0d,
      0xb8,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0xc8,
      0xd5
    )

    expect(
      parseTrackerAnnounceResponse(
        validResponse({
          complete: 7,
          incomplete: 8,
          'min interval': 900,
          peers,
          peers6,
          'tracker id': Uint8Array.of(1, 2),
          'warning message': 'maintenance soon'
        })
      )
    ).toEqual({
      complete: 7,
      incomplete: 8,
      interval: 1_800,
      minInterval: 900,
      peers: [{ address: '1.2.3.4', family: 4, port: 6_881 }],
      trackerId: Uint8Array.of(1, 2),
      warningMessage: 'maintenance soon'
    })
  })

  it('parses dictionary peers and de-duplicates endpoints', () => {
    const peerId = Uint8Array.from({ length: 20 }, () => 7)
    const result = parseTrackerAnnounceResponse(
      validResponse({
        peers: [
          { ip: '8.8.4.4', 'peer id': peerId, port: 6_881 },
          { ip: '8.8.4.4', port: 6_881 },
          { ip: '2001:db8::9', port: 6_882 }
        ]
      })
    )

    expect(result.peers).toEqual([
      { address: '8.8.4.4', family: 4, peerId, port: 6_881 }
    ])
    expect(result.peers[0]?.peerId).not.toBe(peerId)
  })

  it('drops a dictionary peer that declares the local peer ID', () => {
    const localPeerId = new Uint8Array(20).fill(7)
    const remotePeerId = new Uint8Array(20).fill(8)

    expect(
      parseTrackerAnnounceResponse(
        validResponse({
          peers: [
            { ip: '8.8.8.8', 'peer id': localPeerId, port: 6_881 },
            { ip: '8.8.4.4', 'peer id': remotePeerId, port: 6_882 }
          ]
        }),
        { localPeerId }
      ).peers
    ).toEqual([
      {
        address: '8.8.4.4',
        family: 4,
        peerId: remotePeerId,
        port: 6_882
      }
    ])
  })

  it('rejects more than 82 accepted peers, including across address families', () => {
    const tooManyIpv4 = new Uint8Array(83 * 6)
    expect(() =>
      parseTrackerAnnounceResponse(validResponse({ peers: tooManyIpv4 }))
    ).toThrowError(expect.objectContaining({ code: 'PEER_LIMIT' }))

    const ipv4 = new Uint8Array(50 * 6)
    const ipv6 = new Uint8Array(33 * 18)
    for (let offset = 0; offset < ipv4.byteLength; offset += 6) {
      ipv4[offset + 5] = 1
    }
    for (let offset = 0; offset < ipv6.byteLength; offset += 18) {
      ipv6[offset + 17] = 1
    }
    expect(() =>
      parseTrackerAnnounceResponse(validResponse({ peers: ipv4, peers6: ipv6 }))
    ).toThrowError(expect.objectContaining({ code: 'PEER_LIMIT' }))
  })

  it.each([
    ['duplicate dictionary key', 'd8:intervali1e8:intervali2ee'],
    ['unsorted dictionary key', 'd5:peers0:8:intervali1ee'],
    ['non-canonical integer', 'd8:intervali01e5:peers0:e'],
    ['trailing bytes', 'd8:intervali1e5:peers0:ejunk'],
    ['invalid compact IPv4 length', 'd8:intervali1e5:peers1:xe'],
    [
      'zero compact peer port',
      'd8:intervali1e5:peers6:\u0001\u0002\u0003\u0004\u0000\u0000e'
    ]
  ])('strictly rejects %s', (_label, source) => {
    expect(() =>
      parseTrackerAnnounceResponse(new TextEncoder().encode(source))
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
  })

  it('bounds tracker messages and never puts failure text in the error', () => {
    const secretReason =
      'private passkey rejected at https://tracker.example/private'
    let failure: unknown
    try {
      parseTrackerAnnounceResponse(
        bencode.encode({ 'failure reason': secretReason })
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(TrackerHttpError)
    expect(failure).toMatchObject({ code: 'TRACKER_FAILURE' })
    expect(String(failure)).not.toContain(secretReason)
    expect(() =>
      parseTrackerAnnounceResponse(
        validResponse({ 'warning message': new Uint8Array(513) })
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
    expect(() =>
      parseTrackerAnnounceResponse(
        validResponse({ 'warning message': 'unsafe\nmessage' })
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
  })

  it('rejects invalid peer dictionary values and unsafe response types', () => {
    for (const peers of [
      [{ ip: 'tracker.example', port: 6_881 }],
      [{ ip: '127.0.0.1%lo0', port: 6_881 }],
      [{ ip: '127.0.0.1', port: 0 }],
      [{ ip: '127.0.0.1', 'peer id': Uint8Array.of(1), port: 6_881 }],
      ['not-a-dictionary']
    ]) {
      expect(() =>
        parseTrackerAnnounceResponse(validResponse({ peers }))
      ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
    }
    expect(() =>
      parseTrackerAnnounceResponse(validResponse({ peers6: [] }))
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
    expect(() =>
      parseTrackerAnnounceResponse(validResponse({ interval: 0 }))
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }))
  })

  it('normalizes untrusted intervals into a safe announce window', () => {
    expect(
      parseTrackerAnnounceResponse(validResponse({ interval: 1 })).interval
    ).toBe(60)
    expect(
      parseTrackerAnnounceResponse(
        validResponse({
          interval: 2_147_483_647,
          'min interval': 2_147_483_647
        })
      )
    ).toMatchObject({
      interval: 86_400,
      minInterval: 86_400
    })
  })
})
