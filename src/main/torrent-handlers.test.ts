import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import type { Diagnostics } from './diagnostics'
import {
  TorrentHandlers,
  TORRENT_HANDLER_LIMITS,
  type TorrentHandlerIntent
} from './torrent-handlers'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'
const MAGNET = `magnet:?xt=urn:btih:${INFO_HASH}`

let root = ''
let torrentPath = ''
let intents: TorrentHandlerIntent[] = []
let registered: boolean | null = null
let handlers: TorrentHandlers

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-handlers-'))
  torrentPath = path.join(root, 'example.torrent')
  await writeFile(torrentPath, 'd4:infod4:name4:teste')
  intents = []
  registered = null
  handlers = new TorrentHandlers({
    diagnostics: diagnostics(),
    electronApp: {
      isDefaultProtocolClient: () => registered === true,
      removeAsDefaultProtocolClient: () => {
        registered = false
        return true
      },
      setAsDefaultProtocolClient: () => {
        registered = true
        return true
      }
    },
    onIntent: intent => intents.push(intent)
  })
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('TorrentHandlers', () => {
  it('accepts a magnet URL and rejects every other scheme', () => {
    expect(handlers.handleUrl(MAGNET)).toBe(true)
    expect(intents).toEqual([{ kind: 'magnet', magnet: MAGNET }])

    for (const value of [
      'https://example.com/file.torrent',
      'file:///etc/passwd',
      'javascript:alert(1)',
      `magnet:?xt=${'x'.repeat(TORRENT_HANDLER_LIMITS.maxMagnetLength)}`,
      'not a url',
      42
    ]) {
      expect(handlers.handleUrl(value)).toBe(false)
    }
    expect(intents).toHaveLength(1)
  })

  it('accepts a real torrent file and refuses anything else', async () => {
    expect(await handlers.handleFile(torrentPath)).toBe(true)
    expect(intents).toEqual([{ kind: 'torrent-file', torrentPath }])

    const other = path.join(root, 'notes.txt')
    await writeFile(other, 'text')
    const linked = path.join(root, 'linked.torrent')
    await symlink(torrentPath, linked)
    const oversized = path.join(root, 'huge.torrent')
    await writeFile(
      oversized,
      Buffer.alloc(TORRENT_HANDLER_LIMITS.maxTorrentBytes + 1)
    )

    for (const candidate of [
      other,
      linked,
      oversized,
      'example.torrent',
      `${root}/./example.torrent`,
      path.join(root, 'absent.torrent')
    ]) {
      expect(await handlers.handleFile(candidate)).toBe(false)
    }
    expect(intents).toHaveLength(1)
  })

  it('reads recognized launch arguments and ignores the rest', async () => {
    const handled = await handlers.handleArguments([
      '/Applications/WebTorrent Updated.app',
      '--enable-logging',
      MAGNET,
      torrentPath,
      '/etc/passwd'
    ])

    expect(handled).toBe(2)
    expect(intents.map(intent => intent.kind)).toEqual([
      'magnet',
      'torrent-file'
    ])
  })

  it('never takes over the OS default without an explicit request', () => {
    expect(handlers.isDefaultHandler()).toBe(false)
    expect(registered).toBeNull()

    expect(handlers.setDefaultHandler(true)).toBe(true)
    expect(handlers.isDefaultHandler()).toBe(true)
    expect(handlers.setDefaultHandler(false)).toBe(true)
    expect(handlers.isDefaultHandler()).toBe(false)
  })

  it('reports a refused registration instead of throwing', () => {
    const failing = new TorrentHandlers({
      diagnostics: diagnostics(),
      electronApp: {
        isDefaultProtocolClient: () => {
          throw new Error('unavailable')
        },
        removeAsDefaultProtocolClient: () => {
          throw new Error('unavailable')
        },
        setAsDefaultProtocolClient: () => {
          throw new Error('unavailable')
        }
      },
      onIntent: () => undefined
    })

    expect(failing.isDefaultHandler()).toBe(false)
    expect(failing.setDefaultHandler(true)).toBe(false)
  })

  it('contains a failing intent handler', () => {
    const throwing = new TorrentHandlers({
      diagnostics: diagnostics(),
      electronApp: {
        isDefaultProtocolClient: () => false,
        removeAsDefaultProtocolClient: () => true,
        setAsDefaultProtocolClient: () => true
      },
      onIntent: () => {
        throw new Error('handler failed')
      }
    })

    expect(throwing.handleUrl(MAGNET)).toBe(true)
  })
})
