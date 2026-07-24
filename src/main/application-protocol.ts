import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { net, type Session } from 'electron'

export const APPLICATION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')
export const RENDERER_CONNECTION_ALLOWLIST = '(response-origin);webrtc=block'

const APPLICATION_SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Connection-Allowlist': RENDERER_CONNECTION_ALLOWLIST,
  'Content-Security-Policy': APPLICATION_CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off'
} as const

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
])

function response(status: number): Response {
  return new Response(null, {
    status,
    headers: APPLICATION_SECURITY_HEADERS
  })
}

export function parseApplicationRequestPath(
  request: Pick<Request, 'method' | 'url'>
): string | null {
  const authorityStart = request.url.indexOf('://')
  const pathStart =
    authorityStart < 0 ? -1 : request.url.indexOf('/', authorityStart + 3)
  const rawPath =
    pathStart < 0
      ? '/'
      : (request.url.slice(pathStart).split(/[?#]/u, 1)[0] ?? '/')
  let rawSegments: string[]
  try {
    rawSegments = rawPath.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
  if (rawSegments.some(segment => segment === '.' || segment === '..')) {
    return null
  }

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }

  if (
    request.method !== 'GET' ||
    url.protocol !== 'app:' ||
    url.hostname !== 'bundle' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    /%(?:00|2f|5c)/iu.test(url.pathname)
  ) {
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (
    decodedPath.includes('\u0000') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('//')
  ) {
    return null
  }

  const segments = decodedPath.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null
  }

  return segments.join('/') || 'index.html'
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

export function registerApplicationProtocol(
  uiSession: Session,
  rendererRoot: string
): () => void {
  uiSession.protocol.handle('app', async request => {
    const relativePath = parseApplicationRequestPath(request)
    if (!relativePath) return response(404)

    const contentType = CONTENT_TYPES.get(
      path.extname(relativePath).toLowerCase()
    )
    if (!contentType) return response(404)

    try {
      const canonicalRoot = await realpath(rendererRoot)
      const candidate = await realpath(path.resolve(rendererRoot, relativePath))
      if (!isInsideRoot(canonicalRoot, candidate)) return response(404)

      const fileResponse = await net.fetch(pathToFileURL(candidate).toString())
      if (!fileResponse.ok || !fileResponse.body) return response(404)

      return new Response(fileResponse.body, {
        status: 200,
        headers: {
          ...APPLICATION_SECURITY_HEADERS,
          'Content-Type': contentType
        }
      })
    } catch {
      return response(404)
    }
  })

  return () => {
    uiSession.protocol.unhandle('app')
  }
}
