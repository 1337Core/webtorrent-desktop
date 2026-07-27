import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MediaProxy,
  MediaProxyError,
  MEDIA_PROXY_LIMITS,
  type MediaSource
} from './media-proxy'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const PAYLOAD = Buffer.from('0123456789abcdef')

let proxy: MediaProxy
let port = 0
let opened: Array<{ end: number; start: number }> = []

function source(overrides: Partial<MediaSource> = {}): MediaSource {
  return {
    contentType: 'video/mp4',
    createReadStream: range => {
      opened.push(range)
      return Readable.from([PAYLOAD.subarray(range.start, range.end + 1)])
    },
    length: PAYLOAD.byteLength,
    ...overrides
  }
}

async function request(
  url: string,
  init: { headers?: Record<string, string>; method?: string } = {}
): Promise<{ body: string; headers: Headers; status: number }> {
  const response = await fetch(url, {
    headers: {
      host: `${MEDIA_PROXY_LIMITS.host}:${port}`,
      ...init.headers
    },
    method: init.method ?? 'GET'
  })
  return {
    body: await response.text(),
    headers: response.headers,
    status: response.status
  }
}

/**
 * `fetch` refuses to set a Host header, so the wrong-Host case needs a raw
 * request.
 */
function rawRequest(
  url: string,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const call = httpRequest(
      {
        headers,
        host: target.hostname,
        method: 'GET',
        path: target.pathname,
        port: target.port
      },
      response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    call.on('error', reject)
    call.end()
  })
}

beforeEach(async () => {
  opened = []
  proxy = new MediaProxy()
  port = await proxy.start()
})

afterEach(async () => {
  await proxy.shutdown()
})

describe('MediaProxy', () => {
  it('binds loopback and serves exactly one selected file', async () => {
    const lease = proxy.open({
      fileIndex: 2,
      infoHash: INFO_HASH,
      source: source()
    })

    expect(lease.url).toMatch(
      new RegExp(
        `^http://127\\.0\\.0\\.1:${port}/v1/media/[A-Za-z0-9_-]{43}$`,
        'u'
      )
    )
    const response = await request(lease.url)
    expect(response.status).toBe(200)
    expect(response.body).toBe(PAYLOAD.toString())
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })

  it('serves one bounded range and supports seeking', async () => {
    const lease = proxy.open({
      fileIndex: 0,
      infoHash: INFO_HASH,
      source: source()
    })

    const seek = await request(lease.url, { headers: { range: 'bytes=4-7' } })
    expect(seek.status).toBe(206)
    expect(seek.body).toBe('4567')
    expect(seek.headers.get('content-range')).toBe('bytes 4-7/16')
    expect(opened.at(-1)).toEqual({ end: 7, start: 4 })

    const suffix = await request(lease.url, { headers: { range: 'bytes=-4' } })
    expect(suffix.body).toBe('cdef')

    const open = await request(lease.url, { headers: { range: 'bytes=12-' } })
    expect(open.body).toBe('cdef')

    const unsatisfiable = await request(lease.url, {
      headers: { range: 'bytes=99-120' }
    })
    expect(unsatisfiable.status).toBe(416)

    const multipart = await request(lease.url, {
      headers: { range: 'bytes=0-1,4-5' }
    })
    expect(multipart.status).toBe(416)
  })

  it('answers HEAD and trusted-app OPTIONS without a body', async () => {
    const lease = proxy.open({
      fileIndex: 0,
      infoHash: INFO_HASH,
      source: source()
    })

    const head = await request(lease.url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(head.headers.get('content-length')).toBe('16')

    const options = await request(lease.url, {
      headers: {
        'access-control-request-method': 'GET',
        origin: MEDIA_PROXY_LIMITS.applicationOrigin
      },
      method: 'OPTIONS'
    })
    expect(options.status).toBe(204)
    expect(options.headers.get('access-control-allow-origin')).toBe(
      MEDIA_PROXY_LIMITS.applicationOrigin
    )
    expect(options.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, OPTIONS'
    )

    const post = await request(lease.url, { method: 'POST' })
    expect(post.status).toBe(405)
  })

  it('serves an empty asset without inventing a one-byte range', async () => {
    let reads = 0
    const lease = proxy.open({
      fileIndex: 0,
      infoHash: INFO_HASH,
      source: source({
        createReadStream: () => {
          reads += 1
          return Readable.from([])
        },
        length: 0
      })
    })

    const get = await request(lease.url)
    expect(get.status).toBe(200)
    expect(get.body).toBe('')
    expect(get.headers.get('content-length')).toBe('0')
    expect(reads).toBe(0)

    const range = await request(lease.url, {
      headers: { range: 'bytes=0-0' }
    })
    expect(range.status).toBe(416)
    expect(range.headers.get('content-range')).toBe('bytes */0')
    expect(reads).toBe(0)
  })

  it('maps no index route and refuses a truncated path', async () => {
    const lease = proxy.open({
      fileIndex: 0,
      infoHash: INFO_HASH,
      source: source()
    })
    const base = `http://${MEDIA_PROXY_LIMITS.host}:${port}`

    for (const path of [
      '/',
      '/v1',
      '/v1/media',
      '/v1/media/',
      `${MEDIA_PROXY_LIMITS.routePrefix}unknown-token`,
      `${lease.url.slice(base.length)}/extra`
    ]) {
      expect((await request(`${base}${path}`)).status).toBe(404)
    }
  })

  it('rejects a wrong Host and any unexpected Origin', async () => {
    const lease = proxy.open({
      fileIndex: 0,
      infoHash: INFO_HASH,
      source: source()
    })

    expect(
      (await request(lease.url, { headers: { origin: 'https://evil.test' } }))
        .status
    ).toBe(403)
    const trusted = await request(lease.url, {
      headers: { origin: MEDIA_PROXY_LIMITS.applicationOrigin }
    })
    expect(trusted.status).toBe(200)
    expect(trusted.headers.get('access-control-allow-origin')).toBe(
      MEDIA_PROXY_LIMITS.applicationOrigin
    )
    expect(trusted.headers.get('vary')).toBe('Origin')
    const originless = await request(lease.url)
    expect(originless.headers.get('access-control-allow-origin')).toBeNull()
    const hostilePreflight = await request(lease.url, {
      headers: {
        'access-control-request-method': 'GET',
        origin: 'https://evil.test'
      },
      method: 'OPTIONS'
    })
    expect(hostilePreflight.status).toBe(403)
    expect(
      hostilePreflight.headers.get('access-control-allow-origin')
    ).toBeNull()
    expect((await request(lease.url, { method: 'OPTIONS' })).status).toBe(403)
    expect(await rawRequest(lease.url, { host: 'localhost:1' })).toBe(403)
    expect(await rawRequest(lease.url, { host: `127.0.0.1:${port}` })).toBe(200)
  })

  it('revokes on close, torrent removal, and expiry', async () => {
    let now = 1_000
    const scoped = new MediaProxy({ now: () => now, ttlMs: 5_000 })
    const scopedPort = await scoped.start()
    try {
      const first = scoped.open({
        fileIndex: 0,
        infoHash: INFO_HASH,
        source: source()
      })
      const second = scoped.open({
        fileIndex: 1,
        infoHash: INFO_HASH,
        source: source()
      })
      const other = scoped.open({
        fileIndex: 0,
        infoHash: 'fedcba9876543210fedcba9876543210fedcba98',
        source: source()
      })

      expect(scoped.close(first.leaseId)).toBe(true)
      expect(scoped.close(first.leaseId)).toBe(false)
      expect(scoped.revokeTorrent(INFO_HASH)).toBe(1)
      expect(scoped.leaseCount).toBe(1)

      now += 4_000
      expect(scoped.heartbeat(other.leaseId).expiresAtMs).toBe(now + 5_000)
      now += 4_000
      expect(scoped.leaseCount).toBe(1)
      now += 5_000
      expect(() => scoped.heartbeat(other.leaseId)).toThrow(MediaProxyError)
      expect(scoped.leaseCount).toBe(0)

      const response = await fetch(second.url, {
        headers: { host: `${MEDIA_PROXY_LIMITS.host}:${scopedPort}` }
      })
      expect(response.status).toBe(404)
      await response.body?.cancel()
    } finally {
      await scoped.shutdown()
    }
  })

  it('bounds concurrent leases and refuses use after shutdown', async () => {
    for (let index = 0; index < MEDIA_PROXY_LIMITS.maxLeases; index += 1) {
      proxy.open({ fileIndex: index, infoHash: INFO_HASH, source: source() })
    }
    expect(() =>
      proxy.open({ fileIndex: 99, infoHash: INFO_HASH, source: source() })
    ).toThrow(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }) as Error)

    await proxy.shutdown()
    expect(proxy.leaseCount).toBe(0)
    expect(() =>
      proxy.open({ fileIndex: 0, infoHash: INFO_HASH, source: source() })
    ).toThrow(expect.objectContaining({ code: 'CLOSED' }) as Error)
  })
})
