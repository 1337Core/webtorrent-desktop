import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EgressPolicy,
  isPrivateNetworkIpv4,
  isPublicIpv4
} from './network-policy'

const servers: Server[] = []

async function listen(
  handler: RequestListener
): Promise<{ origin: string; port: number }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected an IPv4 test server')
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    )
  )
})

describe('IPv4 egress classification', () => {
  it.each([
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['172.31.0.1', false],
    ['192.168.1.1', false],
    ['198.18.0.1', false],
    ['224.0.0.1', false],
    ['999.1.1.1', false]
  ])(
    'classifies public address %s without ip.isPublic (%s)',
    (value, result) => {
      expect(isPublicIpv4(value)).toBe(result)
    }
  )

  it.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.100.100.200', false],
    ['8.8.8.8', false]
  ])('limits private-network mode to RFC1918 (%s, %s)', (value, result) => {
    expect(isPrivateNetworkIpv4(value)).toBe(result)
  })
})

describe('EgressPolicy URL validation', () => {
  it('accepts mediated tracker transports and explicitly disables UDP', () => {
    const candidate = new EgressPolicy()

    expect(
      candidate.validateTrackerUrl('https://tracker.example/announce')
    ).toBe('https://tracker.example/announce')
    expect(() =>
      candidate.validateTrackerUrl('udp://tracker.example:6969/announce')
    ).toThrowError(
      expect.objectContaining({ code: 'TRACKER_TRANSPORT_DISABLED' })
    )
  })

  it('rejects credentials, fragments, oversized URLs, and insecure sources', () => {
    const candidate = new EgressPolicy()

    expect(() =>
      candidate.validateRemoteTorrentUrl('https://user@example.com/file', {
        allowHttp: false
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_URL' }))
    expect(() =>
      candidate.validateRemoteTorrentUrl('https://example.com/file#fragment', {
        allowHttp: false
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_URL' }))
    expect(() =>
      candidate.validateRemoteTorrentUrl('http://example.com/file', {
        allowHttp: false
      })
    ).toThrowError(expect.objectContaining({ code: 'HTTP_DISABLED' }))
    expect(() =>
      candidate.validateRemoteTorrentUrl(
        `https://example.com/${'a'.repeat(2_100)}`,
        { allowHttp: false }
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_URL' }))
  })

  it.each([false, true])(
    'never permits an HTTPS-to-HTTP redirect (allowHttp=%s)',
    allowHttp => {
      const candidate = new EgressPolicy()

      expect(() =>
        candidate.validateRemoteTorrentRedirect(
          'https://example.com/file.torrent',
          'http://other.example/file.torrent',
          { allowHttp }
        )
      ).toThrowError(expect.objectContaining({ code: 'REDIRECT_BLOCKED' }))
    }
  )
})

describe('EgressPolicy remote torrent fetch', () => {
  it('pins DNS, sends only fixed headers, and returns bounded bytes', async () => {
    const { port } = await listen((request, response) => {
      expect(request.headers.host).toBe(`approved.example:${port}`)
      expect(request.headers.accept).toContain('application/x-bittorrent')
      expect(request.headers['accept-encoding']).toBe('identity')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
      response.writeHead(200, { 'content-type': 'application/x-bittorrent' })
      response.end('torrent')
    })
    const candidate = new EgressPolicy({
      dnsLookup: async hostname => {
        expect(hostname).toBe('approved.example')
        return [{ address: '127.0.0.1', family: 4 }]
      },
      testOnlyAllowLoopback: true
    })

    const result = await candidate.fetchRemoteTorrentBytes(
      `http://approved.example:${port}/torrent`,
      { allowHttp: true }
    )

    expect(result.finalUrl).toBe(`http://approved.example:${port}/torrent`)
    expect(new TextDecoder().decode(result.bytes)).toBe('torrent')
  })

  it('rejects mixed DNS answers and excessive resolver output', async () => {
    const mixed = new EgressPolicy({
      dnsLookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 }
      ]
    })
    await expect(
      mixed.fetchRemoteTorrentBytes('https://rebinding.example/file.torrent', {
        allowHttp: false
      })
    ).rejects.toMatchObject({ code: 'ADDRESS_BLOCKED' })

    const excessive = new EgressPolicy({
      dnsLookup: async () =>
        Array.from({ length: 17 }, () => ({
          address: '93.184.216.34',
          family: 4
        }))
    })
    await expect(
      excessive.fetchRemoteTorrentBytes(
        'https://many-answers.example/file.torrent',
        { allowHttp: false }
      )
    ).rejects.toMatchObject({ code: 'DNS_FAILED' })
  })

  it('keeps loopback and link-local blocked in production private-network mode', async () => {
    const privateMode = new EgressPolicy({ allowPrivateNetwork: true })

    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '169.254.170.2',
      '100.100.100.200'
    ]) {
      await expect(
        privateMode.fetchRemoteTorrentBytes(`http://${address}/torrent`, {
          allowHttp: true
        })
      ).rejects.toMatchObject({ code: 'ADDRESS_BLOCKED' })
    }
  })

  it('normalizes and rejects obfuscated or IPv6 loopback literals', async () => {
    const candidate = new EgressPolicy()
    for (const host of [
      '127.1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      '[::1]',
      '[::ffff:127.0.0.1]'
    ]) {
      await expect(
        candidate.fetchRemoteTorrentBytes(`http://${host}/torrent`, {
          allowHttp: true
        })
      ).rejects.toMatchObject({ code: 'ADDRESS_BLOCKED' })
    }
  })

  it('revalidates every redirect and enforces the configured count', async () => {
    const { origin } = await listen((request, response) => {
      const count = Number(request.url?.slice(1) || '0')
      response.writeHead(302, { location: `/${count + 1}` })
      response.end()
    })
    const candidate = new EgressPolicy({
      maxRedirects: 1,
      testOnlyAllowLoopback: true
    })

    await expect(
      candidate.fetchRemoteTorrentBytes(`${origin}/0`, { allowHttp: true })
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
  })

  it('rejects oversized declarations and non-200 response bodies', async () => {
    const oversized = await listen((_request, response) => {
      response.writeHead(200, { 'content-length': '10000001' })
      response.end()
    })
    const badStatus = await listen((_request, response) => {
      response.writeHead(404)
      response.end('do not buffer me')
    })
    const candidate = new EgressPolicy({ testOnlyAllowLoopback: true })

    await expect(
      candidate.fetchRemoteTorrentBytes(`${oversized.origin}/large`, {
        allowHttp: true
      })
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
    await expect(
      candidate.fetchRemoteTorrentBytes(`${badStatus.origin}/missing`, {
        allowHttp: true
      })
    ).rejects.toMatchObject({ code: 'HTTP_STATUS' })
  })

  it('uses one deadline that includes DNS and limits concurrent fetches', async () => {
    const timeout = new EgressPolicy({
      dnsLookup: async () => await new Promise(() => undefined),
      dnsTimeoutMs: 1_000,
      requestTimeoutMs: 10
    })
    await expect(
      timeout.fetchRemoteTorrentBytes(
        'https://never-resolves.example/file.torrent',
        { allowHttp: false }
      )
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })

    const { origin } = await listen(() => undefined)
    const candidate = new EgressPolicy({
      requestTimeoutMs: 1_000,
      testOnlyAllowLoopback: true
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = candidate.fetchRemoteTorrentBytes(`${origin}/one`, {
      allowHttp: true,
      signal: firstController.signal
    })
    const second = candidate.fetchRemoteTorrentBytes(`${origin}/two`, {
      allowHttp: true,
      signal: secondController.signal
    })

    await expect(
      candidate.fetchRemoteTorrentBytes(`${origin}/three`, {
        allowHttp: true
      })
    ).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' })
    firstController.abort()
    secondController.abort()
    await Promise.allSettled([first, second])
  })
})
