import bencode from 'bencode'
import { describe, expect, it } from 'vitest'
import {
  decodeDhtDatagram,
  DhtIngressLimiter,
  DhtTransactionIds,
  DhtWireError,
  DHT_WIRE_LIMITS,
  sanitizeCompactNodes,
  sanitizeCompactPeers
} from './dht-wire'

const NODE_ID = new Uint8Array(20).fill(7)
const INFO_HASH = new Uint8Array(20).fill(9)

function encode(value: Record<string, unknown>): Uint8Array {
  return new Uint8Array(bencode.encode(value))
}

function query(method: string, args: Record<string, unknown> = {}): Uint8Array {
  return encode({
    a: { id: NODE_ID, ...args },
    q: method,
    t: new Uint8Array([0x2a, 0x3b]),
    y: 'q'
  })
}

function compactNode(address: string, port: number): Uint8Array {
  const bytes = new Uint8Array(26)
  bytes.set(NODE_ID, 0)
  address.split('.').forEach((octet, index) => {
    bytes[20 + index] = Number(octet)
  })
  bytes[24] = (port >> 8) & 0xff
  bytes[25] = port & 0xff
  return bytes
}

function compactPeer(address: string, port: number): Uint8Array {
  const bytes = new Uint8Array(6)
  address.split('.').forEach((octet, index) => {
    bytes[index] = Number(octet)
  })
  bytes[4] = (port >> 8) & 0xff
  bytes[5] = port & 0xff
  return bytes
}

describe('decodeDhtDatagram', () => {
  it('accepts the four permitted queries', () => {
    expect(decodeDhtDatagram(query('ping'))).toMatchObject({
      kind: 'query',
      method: 'ping'
    })
    expect(
      decodeDhtDatagram(query('find_node', { target: INFO_HASH }))
    ).toMatchObject({ method: 'find_node' })
    expect(
      decodeDhtDatagram(query('get_peers', { info_hash: INFO_HASH }))
    ).toMatchObject({ method: 'get_peers' })
    expect(
      decodeDhtDatagram(
        query('announce_peer', {
          info_hash: INFO_HASH,
          port: 6881,
          token: new Uint8Array([1, 2, 3, 4])
        })
      )
    ).toMatchObject({ method: 'announce_peer' })
  })

  it('rejects BEP 44 and every other unknown method', () => {
    for (const method of ['get', 'put', 'vote', 'sample_infohashes']) {
      expect(() => decodeDhtDatagram(query(method))).toThrow(
        expect.objectContaining({ code: 'METHOD_NOT_ALLOWED' }) as Error
      )
    }
  })

  it('enforces the exact datagram ceiling', () => {
    const exact = new Uint8Array(DHT_WIRE_LIMITS.maxDatagramBytes)
    expect(() => decodeDhtDatagram(exact)).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVELOPE' }) as Error
    )
    expect(() =>
      decodeDhtDatagram(new Uint8Array(DHT_WIRE_LIMITS.maxDatagramBytes + 1))
    ).toThrow(expect.objectContaining({ code: 'DATAGRAM_TOO_LARGE' }) as Error)
  })

  it('requires exact 20-byte identity fields', () => {
    expect(() =>
      decodeDhtDatagram(
        encode({
          a: { id: new Uint8Array(19) },
          q: 'ping',
          t: new Uint8Array([1]),
          y: 'q'
        })
      )
    ).toThrow(DhtWireError)
    expect(() =>
      decodeDhtDatagram(query('get_peers', { info_hash: new Uint8Array(21) }))
    ).toThrow(DhtWireError)
  })

  it('requires a bounded token and a valid port to announce', () => {
    expect(() =>
      decodeDhtDatagram(
        query('announce_peer', { info_hash: INFO_HASH, port: 6881 })
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }) as Error)
    expect(() =>
      decodeDhtDatagram(
        query('announce_peer', {
          info_hash: INFO_HASH,
          port: 0,
          token: new Uint8Array([1])
        })
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_ENVELOPE' }) as Error)
    expect(() =>
      decodeDhtDatagram(
        query('announce_peer', {
          info_hash: INFO_HASH,
          port: 6881,
          token: new Uint8Array(DHT_WIRE_LIMITS.maxTokenBytes + 1)
        })
      )
    ).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }) as Error)
  })

  it('rejects unsorted, duplicated, deep, and oversized structures', () => {
    const unsorted = Buffer.concat([
      Buffer.from('d1:y1:q1:t2:ab'),
      Buffer.from('e')
    ])
    expect(() => decodeDhtDatagram(new Uint8Array(unsorted))).toThrow(
      expect.objectContaining({ code: 'DICTIONARY_ORDER' }) as Error
    )

    const duplicated = Buffer.from('d1:t2:ab1:t2:abe')
    expect(() => decodeDhtDatagram(new Uint8Array(duplicated))).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_KEY' }) as Error
    )

    let deep = 'le'
    for (let depth = 0; depth < DHT_WIRE_LIMITS.maxDepth + 2; depth += 1) {
      deep = `l${deep}e`
    }
    expect(() =>
      decodeDhtDatagram(new Uint8Array(Buffer.from(`d1:ad1:xe1:t2:abe`)))
    ).toThrow(DhtWireError)
    expect(() =>
      decodeDhtDatagram(new Uint8Array(Buffer.from(`d1:a${deep}e`)))
    ).toThrow(expect.objectContaining({ code: 'DEPTH_LIMIT' }) as Error)
  })

  it('validates then discards every IPv6 answer', () => {
    const message = decodeDhtDatagram(
      encode({
        r: {
          id: NODE_ID,
          nodes: compactNode('93.184.216.34', 6881),
          nodes6: new Uint8Array(38),
          values6: [new Uint8Array(18)]
        },
        t: new Uint8Array([1, 2]),
        y: 'r'
      })
    )

    if (message.kind !== 'response') throw new Error('Expected a response')
    expect(message.response.has('nodes6')).toBe(false)
    expect(message.response.has('values6')).toBe(false)
    expect(message.response.has('nodes')).toBe(true)

    expect(() =>
      decodeDhtDatagram(
        encode({
          r: { id: NODE_ID, nodes6: new Uint8Array(37) },
          t: new Uint8Array([1, 2]),
          y: 'r'
        })
      )
    ).toThrow(DhtWireError)
  })

  it('rejects malformed compact node and peer encodings', () => {
    expect(() =>
      decodeDhtDatagram(
        encode({
          r: { id: NODE_ID, nodes: new Uint8Array(25) },
          t: new Uint8Array([1, 2]),
          y: 'r'
        })
      )
    ).toThrow(DhtWireError)
    expect(() =>
      decodeDhtDatagram(
        encode({
          r: { id: NODE_ID, values: [new Uint8Array(5)] },
          t: new Uint8Array([1, 2]),
          y: 'r'
        })
      )
    ).toThrow(DhtWireError)
  })

  it('accepts a bounded error envelope', () => {
    expect(
      decodeDhtDatagram(
        encode({ e: [201, 'generic'], t: new Uint8Array([1, 2]), y: 'e' })
      )
    ).toMatchObject({ code: 201, kind: 'error' })
    expect(() =>
      decodeDhtDatagram(
        encode({
          e: [201, new Uint8Array(DHT_WIRE_LIMITS.maxErrorMessageBytes + 1)],
          t: new Uint8Array([1, 2]),
          y: 'e'
        })
      )
    ).toThrow(DhtWireError)
  })
})

describe('sanitizeCompactNodes', () => {
  it('keeps at most twenty public IPv4 contacts', () => {
    const entries = [
      compactNode('93.184.216.34', 6881),
      compactNode('10.0.0.4', 6881),
      compactNode('127.0.0.1', 6881),
      compactNode('169.254.0.1', 6881),
      compactNode('100.64.0.1', 6881),
      compactNode('93.184.216.35', 0),
      ...Array.from({ length: 25 }, (_value, index) =>
        compactNode(`45.33.32.${index + 1}`, 7000 + index)
      )
    ]
    const bytes = new Uint8Array(entries.length * 26)
    entries.forEach((entry, index) => bytes.set(entry, index * 26))

    const nodes = sanitizeCompactNodes(bytes)
    expect(nodes).toHaveLength(DHT_WIRE_LIMITS.maxSanitizedNodes)
    expect(nodes[0]).toMatchObject({ address: '93.184.216.34', port: 6881 })
    expect(nodes.every(node => node.address !== '10.0.0.4')).toBe(true)
    expect(sanitizeCompactNodes(undefined)).toEqual([])
  })
})

describe('sanitizeCompactPeers', () => {
  it('drops private and malformed peers and honours the cap', () => {
    const peers = sanitizeCompactPeers(
      [
        compactPeer('93.184.216.39', 6881),
        compactPeer('192.168.1.5', 6881),
        new Uint8Array(3),
        compactPeer('45.33.32.9', 51_413)
      ],
      10
    )
    expect(peers).toEqual([
      { address: '93.184.216.39', port: 6881 },
      { address: '45.33.32.9', port: 51_413 }
    ])
    expect(
      sanitizeCompactPeers([compactPeer('93.184.216.39', 6881)], 0)
    ).toEqual([])
  })
})

describe('DhtTransactionIds', () => {
  it('never reuses an active identifier', () => {
    const values = [0x00_01, 0x00_01, 0x00_02]
    let index = 0
    const ids = new DhtTransactionIds(() => {
      const value = values[Math.min(index, values.length - 1)] ?? 0
      index += 1
      return new Uint8Array([(value >> 8) & 0xff, value & 0xff])
    })

    expect(ids.allocate()).toBe(1)
    expect(ids.allocate()).toBe(2)
    expect(ids.size).toBe(2)
    expect(ids.release(1)).toBe(true)
    expect(ids.release(1)).toBe(false)
    expect(ids.has(2)).toBe(true)
  })
})

describe('DhtIngressLimiter', () => {
  it('bounds one source without starving the others', () => {
    let now = 0
    const limiter = new DhtIngressLimiter(() => now)

    let accepted = 0
    for (
      let attempt = 0;
      attempt < DHT_WIRE_LIMITS.sourceBurst + 5;
      attempt += 1
    ) {
      if (limiter.accept('93.184.216.34')) accepted += 1
    }
    expect(accepted).toBe(DHT_WIRE_LIMITS.sourceBurst)
    expect(limiter.accept('45.33.32.7')).toBe(true)

    now += 1_000
    expect(limiter.accept('93.184.216.34')).toBe(true)
  })

  it('bounds total ingress across every source', () => {
    let now = 0
    const limiter = new DhtIngressLimiter(() => now)

    let accepted = 0
    for (let source = 0; source < 64; source += 1) {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        if (limiter.accept(`45.33.32.${source}`)) accepted += 1
      }
    }
    expect(accepted).toBe(DHT_WIRE_LIMITS.globalBurst)
  })

  it('keeps the source table bounded', () => {
    let now = 0
    const limiter = new DhtIngressLimiter(() => now)

    for (
      let index = 0;
      index < DHT_WIRE_LIMITS.maxSourceEntries + 50;
      index += 1
    ) {
      now += 4
      limiter.accept(`source-${index}`)
    }
    expect(limiter.trackedSources).toBeLessThanOrEqual(
      DHT_WIRE_LIMITS.maxSourceEntries
    )
  })
})
