import path from 'node:path'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => ({
  fetch: vi.fn()
}))
vi.mock('electron', () => ({
  net: {
    fetch: electronMock.fetch
  }
}))

import {
  APPLICATION_CSP,
  buildApplicationCsp,
  RENDERER_CONNECTION_ALLOWLIST,
  parseApplicationRequestPath,
  registerApplicationProtocol
} from './application-protocol'

const temporaryDirectories: string[] = []

function request(url: string, method = 'GET'): Pick<Request, 'method' | 'url'> {
  return { method, url }
}

afterEach(async () => {
  electronMock.fetch.mockReset()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true }))
  )
})

describe('parseApplicationRequestPath', () => {
  it('maps the trusted root and renderer assets', () => {
    expect(
      parseApplicationRequestPath(request('app://bundle/index.html'))
    ).toBe('index.html')
    expect(parseApplicationRequestPath(request('app://bundle/'))).toBe(
      'index.html'
    )
    expect(
      parseApplicationRequestPath(request('app://bundle/assets/index.js'))
    ).toBe('assets/index.js')
  })

  it.each([
    ['https://bundle/index.html', 'GET'],
    ['app://other/index.html', 'GET'],
    ['app://user@bundle/index.html', 'GET'],
    ['app://bundle:99/index.html', 'GET'],
    ['app://bundle/index.html?x=1', 'GET'],
    ['app://bundle/index.html#fragment', 'GET'],
    ['app://bundle/index.html', 'POST'],
    ['app://bundle/%', 'GET'],
    ['app://bundle/%00index.html', 'GET'],
    ['app://bundle/assets%2findex.js', 'GET'],
    ['app://bundle/assets%5cindex.js', 'GET'],
    ['app://bundle//index.html', 'GET'],
    ['app://bundle/a/../index.html', 'GET']
  ])('rejects an untrusted request %s %s', (url, method) => {
    expect(parseApplicationRequestPath(request(url, method))).toBeNull()
  })
})

describe('registerApplicationProtocol', () => {
  async function createHarness(): Promise<{
    cleanup: () => void
    handle: (request: Pick<Request, 'method' | 'url'>) => Promise<Response>
    rendererRoot: string
    unhandle: ReturnType<typeof vi.fn>
  }> {
    const rendererRoot = await mkdtemp(
      path.join(tmpdir(), 'webtorrent-updated-renderer-')
    )
    temporaryDirectories.push(rendererRoot)
    await writeFile(path.join(rendererRoot, 'index.html'), '<!doctype html>')
    await writeFile(path.join(rendererRoot, 'application.js'), 'export {}')

    let handle:
      | ((request: Pick<Request, 'method' | 'url'>) => Promise<Response>)
      | undefined
    const unhandle = vi.fn()
    const session = {
      protocol: {
        handle: vi.fn(
          (
            _scheme: string,
            handler: (
              request: Pick<Request, 'method' | 'url'>
            ) => Promise<Response>
          ) => {
            handle = handler
          }
        ),
        unhandle
      }
    }
    const cleanup = registerApplicationProtocol(session as never, rendererRoot)
    if (!handle) throw new Error('Expected an application protocol handler')
    return { cleanup, handle, rendererRoot, unhandle }
  }

  it('serves only real allowlisted renderer files with security headers', async () => {
    const { handle } = await createHarness()
    electronMock.fetch.mockResolvedValue(
      new Response('export {}', { status: 200 })
    )

    const response = await handle(request('app://bundle/application.js'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8'
    )
    expect(response.headers.get('content-security-policy')).toBe(
      APPLICATION_CSP
    )
    expect(response.headers.get('connection-allowlist')).toBe(
      RENDERER_CONNECTION_ALLOWLIST
    )
    expect(response.headers.get('x-dns-prefetch-control')).toBe('off')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(electronMock.fetch).toHaveBeenCalledOnce()
  })

  it('returns a uniform not-found response for missing and unsupported files', async () => {
    const { handle } = await createHarness()

    for (const url of ['app://bundle/missing.js', 'app://bundle/secret.json']) {
      const response = await handle(request(url))
      expect(response.status).toBe(404)
      expect(response.headers.get('content-security-policy')).toBe(
        APPLICATION_CSP
      )
    }
    expect(electronMock.fetch).not.toHaveBeenCalled()
  })

  it('refuses a symlink that resolves outside the renderer root', async () => {
    const { handle, rendererRoot } = await createHarness()
    const outsideDirectory = await mkdtemp(
      path.join(tmpdir(), 'webtorrent-updated-outside-')
    )
    temporaryDirectories.push(outsideDirectory)
    const outsideFile = path.join(outsideDirectory, 'outside.js')
    await writeFile(outsideFile, 'export const secret = true')
    await symlink(outsideFile, path.join(rendererRoot, 'linked.js'))

    const response = await handle(request('app://bundle/linked.js'))

    expect(response.status).toBe(404)
    expect(electronMock.fetch).not.toHaveBeenCalled()
  })

  it('unregisters only the private app protocol', async () => {
    const { cleanup, unhandle } = await createHarness()

    cleanup()

    expect(unhandle).toHaveBeenCalledOnce()
    expect(unhandle).toHaveBeenCalledWith('app')
  })

  it('authorizes only the exact loopback media port', () => {
    expect(APPLICATION_CSP).toContain("media-src 'none'")
    expect(buildApplicationCsp(52_000)).toContain(
      'media-src http://127.0.0.1:52000'
    )
    expect(buildApplicationCsp(52_000)).toContain(
      "img-src 'self' data: http://127.0.0.1:52000"
    )
    expect(buildApplicationCsp(52_000)).not.toContain('localhost')

    for (const invalid of [0, 65_536, -1, 1.5, Number.NaN]) {
      expect(buildApplicationCsp(invalid)).toContain("media-src 'none'")
      expect(buildApplicationCsp(invalid)).toContain("img-src 'self' data:")
      expect(buildApplicationCsp(invalid)).not.toContain(
        'img-src http://127.0.0.1'
      )
    }
  })
})
