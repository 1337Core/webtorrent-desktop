import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EgressPolicy,
  isPrivateNetworkIpv4,
  isPublicIpv4
} from './network-policy'
import { TRACKER_HTTP_EGRESS_PROFILE } from './tracker-http-profile'

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
  it('accepts mediated tracker transports and disables UDP and cleartext WS', () => {
    const candidate = new EgressPolicy()

    expect(
      candidate.validateTrackerUrl('https://tracker.example/announce')
    ).toBe('https://tracker.example/announce')
    expect(candidate.validateTrackerUrl('wss://tracker.example/announce')).toBe(
      'wss://tracker.example/announce'
    )
    for (const disabled of [
      'udp://tracker.example:6969/announce',
      'ws://tracker.example/announce'
    ]) {
      expect(() => candidate.validateTrackerUrl(disabled)).toThrowError(
        expect.objectContaining({ code: 'TRACKER_TRANSPORT_DISABLED' })
      )
    }
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
      expect(() =>
        candidate.validateTrackerHttpRedirect(
          'https://tracker.example/announce',
          'http://other.example/announce',
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

describe('EgressPolicy tracker HTTP fetch', () => {
  it('pins DNS, supplies fixed tracker headers, and omits ambient credentials', async () => {
    const { port } = await listen((request, response) => {
      expect(request.headers.host).toBe(`tracker.example:${port}`)
      expect(request.headers.accept).toBe(
        TRACKER_HTTP_EGRESS_PROFILE.headers.accept
      )
      expect(request.headers['accept-encoding']).toBe('identity')
      expect(request.headers['cache-control']).toBe('no-store')
      expect(request.headers['user-agent']).toBe(
        TRACKER_HTTP_EGRESS_PROFILE.headers['user-agent']
      )
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.referer).toBeUndefined()
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('tracker response')
    })
    const candidate = new EgressPolicy({
      dnsLookup: async hostname => {
        expect(hostname).toBe('tracker.example')
        return [{ address: '127.0.0.1', family: 4 }]
      },
      testOnlyAllowLoopback: true
    })

    const result = await candidate.fetchTrackerResponse(
      `http://tracker.example:${port}/announce`,
      { allowHttp: true, signal: new AbortController().signal }
    )

    expect(new TextDecoder().decode(result.bytes)).toBe('tracker response')
  })

  it('allows exactly three revalidated redirects and rejects a fourth', async () => {
    const visited: string[] = []
    const resolvedHosts: string[] = []
    const { port } = await listen((request, response) => {
      const path = request.url ?? ''
      visited.push(path)
      const count = Number(path.split('/').at(-1))
      if (path.startsWith('/allowed/') && count === 3) {
        response.writeHead(200)
        response.end('ok')
        return
      }
      response.writeHead(302, {
        location:
          count === 0
            ? `http://redirected.example:${port}${path.slice(0, path.lastIndexOf('/') + 1)}1`
            : `${path.slice(0, path.lastIndexOf('/') + 1)}${count + 1}`
      })
      response.end()
    })
    const candidate = new EgressPolicy({
      dnsLookup: async hostname => {
        resolvedHosts.push(hostname)
        return [{ address: '127.0.0.1', family: 4 }]
      },
      testOnlyAllowLoopback: true
    })

    await expect(
      candidate.fetchTrackerResponse(
        `http://initial.example:${port}/allowed/0`,
        {
          allowHttp: true,
          signal: new AbortController().signal
        }
      )
    ).resolves.toMatchObject({ bytes: new TextEncoder().encode('ok') })
    expect(visited).toEqual([
      '/allowed/0',
      '/allowed/1',
      '/allowed/2',
      '/allowed/3'
    ])
    expect(resolvedHosts).toEqual([
      'initial.example',
      'redirected.example',
      'redirected.example',
      'redirected.example'
    ])

    visited.length = 0
    resolvedHosts.length = 0
    await expect(
      candidate.fetchTrackerResponse(
        `http://initial.example:${port}/blocked/0`,
        {
          allowHttp: true,
          signal: new AbortController().signal
        }
      )
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' })
    expect(visited).toEqual([
      '/blocked/0',
      '/blocked/1',
      '/blocked/2',
      '/blocked/3'
    ])
    expect(resolvedHosts).toEqual([
      'initial.example',
      'redirected.example',
      'redirected.example',
      'redirected.example'
    ])
  })

  it('enforces explicit HTTP consent and the one-MiB streamed body cap', async () => {
    const { origin } = await listen((request, response) => {
      if (request.url === '/encoded') {
        response.writeHead(200, { 'content-encoding': 'gzip' })
        response.end('not actually compressed')
        return
      }
      response.writeHead(200)
      response.write(
        new Uint8Array(TRACKER_HTTP_EGRESS_PROFILE.maxResponseBytes)
      )
      response.end(Uint8Array.of(1))
    })
    const candidate = new EgressPolicy({ testOnlyAllowLoopback: true })

    await expect(
      candidate.fetchTrackerResponse(`${origin}/announce`, {
        allowHttp: false,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'HTTP_DISABLED' })
    await expect(
      candidate.fetchTrackerResponse(`${origin}/announce`, {
        allowHttp: true,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' })
    await expect(
      candidate.fetchTrackerResponse(`${origin}/encoded`, {
        allowHttp: true,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'RESPONSE_ENCODING_BLOCKED' })
  })

  it('propagates caller abort while DNS is still pending', async () => {
    const candidate = new EgressPolicy({
      dnsLookup: async () => await new Promise(() => undefined)
    })
    const controller = new AbortController()
    const fetch = candidate.fetchTrackerResponse(
      'https://pending.example/announce',
      { allowHttp: false, signal: controller.signal }
    )

    controller.abort()

    await expect(fetch).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('rejects a body completion observed after the absolute deadline', async () => {
    let now = 1_000
    const { origin } = await listen((_request, response) => {
      now += TRACKER_HTTP_EGRESS_PROFILE.absoluteDeadlineMs
      response.writeHead(200)
      response.end('late')
    })
    const candidate = new EgressPolicy({
      now: () => now,
      testOnlyAllowLoopback: true
    })

    await expect(
      candidate.fetchTrackerResponse(`${origin}/announce`, {
        allowHttp: true,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
  })
})
