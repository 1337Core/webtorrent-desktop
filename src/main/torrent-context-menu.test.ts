import { describe, expect, it, vi } from 'vitest'
import type { EngineCommand, EngineCommandResult } from '../shared/contracts'
import type { Diagnostics } from './diagnostics'
import type { PayloadTrash } from './payload-trash'
import type { AppStateStore } from './state-store'
import type { TorrentLibrary } from './torrent-library'
import {
  TorrentContextMenu,
  type MenuTemplateItem
} from './torrent-context-menu'

const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

function harness(
  options: {
    files?: ReadonlyArray<{ nextCursor: number | null; paths: string[] }>
    name?: string
    removeFails?: boolean
  } = {}
): {
  copied: string[]
  deleted: unknown[]
  executed: EngineCommand[]
  menu: TorrentContextMenu
  removed: string[]
  revealed: string[]
  template: () => ReadonlyArray<MenuTemplateItem>
} {
  const copied: string[] = []
  const deleted: unknown[] = []
  const executed: EngineCommand[] = []
  const removed: string[] = []
  const revealed: string[] = []
  let captured: ReadonlyArray<MenuTemplateItem> = []
  const pages = options.files ?? [
    { nextCursor: null, paths: ['payload/one.bin', 'payload/two.bin'] }
  ]
  let page = 0

  const menu = new TorrentContextMenu({
    buildMenu: template => {
      captured = template
      return { popup: () => undefined }
    },
    copyText: text => copied.push(text),
    diagnostics: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    } as unknown as Diagnostics,
    execute: operation => {
      executed.push(operation)
      if (operation.command === 'get-torrent-files') {
        const current = pages[page] ?? { nextCursor: null, paths: [] }
        page += 1
        return Promise.resolve({
          ok: true,
          result: {
            command: 'get-torrent-files',
            value: {
              infoHash: INFO_HASH,
              items: current.paths.map((filePath, index) => ({
                downloaded: 0,
                index,
                length: 1,
                path: filePath,
                progress: 0,
                selected: true
              })),
              nextCursor: current.nextCursor,
              total: current.paths.length
            }
          }
        } as unknown as EngineCommandResult)
      }
      if (options.removeFails) {
        return Promise.resolve({
          ok: false,
          error: {
            command: 'remove-torrent',
            code: 'STATE_CONFLICT',
            displayMessage: 'The torrent cannot change state right now.',
            retryable: false
          }
        } as EngineCommandResult)
      }
      removed.push(INFO_HASH)
      return Promise.resolve({
        ok: true,
        result: {
          command: 'remove-torrent',
          value: { infoHash: INFO_HASH, removed: true }
        }
      } as EngineCommandResult)
    },
    library: { record: vi.fn() } as unknown as TorrentLibrary,
    payloadTrash: {
      delete: (request: unknown) => {
        deleted.push(request)
        return Promise.resolve({ missing: [], trashed: [] })
      }
    } as unknown as PayloadTrash,
    revealPath: target => revealed.push(target),
    stateStore: {
      listTorrents: () => [
        {
          addedAtMs: 1,
          destinationRoot: '/Users/owner/Downloads',
          infoHash: INFO_HASH,
          name: options.name ?? 'Example payload',
          paused: false,
          private: false
        }
      ]
    } as unknown as AppStateStore
  })

  return {
    copied,
    deleted,
    executed,
    menu,
    removed,
    revealed,
    template: () => captured
  }
}

function click(template: ReadonlyArray<MenuTemplateItem>, label: string): void {
  const item = template.find(entry => entry.label === label)
  if (!item?.click) throw new Error(`No menu item labelled ${label}`)
  item.click()
}

describe('TorrentContextMenu', () => {
  it('builds the original menu for a torrent in the library', () => {
    const context = harness()

    expect(context.menu.open(INFO_HASH)).toBe(true)
    expect(context.template().map(item => item.label ?? '—')).toEqual([
      'Remove From List',
      'Remove Data File',
      '—',
      'Show in Finder',
      '—',
      'Copy Magnet Link to Clipboard'
    ])
  })

  it('shows nothing for a torrent the library does not hold', () => {
    const context = harness()

    expect(context.menu.open('f'.repeat(40))).toBe(false)
  })

  it('reveals the torrent under the root it was saved to', () => {
    const context = harness()
    context.menu.open(INFO_HASH)

    click(context.template(), 'Show in Finder')

    expect(context.revealed).toEqual(['/Users/owner/Downloads/Example payload'])
  })

  it('copies a magnet link built from the torrent identity', () => {
    const context = harness({ name: 'Example payload' })
    context.menu.open(INFO_HASH)

    click(context.template(), 'Copy Magnet Link to Clipboard')

    expect(context.copied).toEqual([
      `magnet:?xt=urn:btih:${INFO_HASH}&dn=Example%20payload`
    ])
  })

  it('removes from the list without touching the payload', async () => {
    const context = harness()
    context.menu.open(INFO_HASH)

    click(context.template(), 'Remove From List')
    await vi.waitFor(() => expect(context.removed).toHaveLength(1))

    expect(context.deleted).toEqual([])
    expect(
      context.executed.some(
        operation => operation.command === 'get-torrent-files'
      )
    ).toBe(false)
  })

  it('reads the manifest before removal, then trashes the payload', async () => {
    const context = harness({
      files: [
        { nextCursor: 2, paths: ['payload/one.bin', 'payload/two.bin'] },
        { nextCursor: null, paths: ['payload/three.bin'] }
      ]
    })
    context.menu.open(INFO_HASH)

    click(context.template(), 'Remove Data File')
    await vi.waitFor(() => expect(context.deleted).toHaveLength(1))

    // Every page of the manifest is read while the torrent still exists.
    expect(context.executed.map(operation => operation.command)).toEqual([
      'get-torrent-files',
      'get-torrent-files',
      'remove-torrent'
    ])
    expect(context.deleted[0]).toEqual({
      files: ['payload/one.bin', 'payload/two.bin', 'payload/three.bin'],
      root: '/Users/owner/Downloads',
      torrentDirectory: 'Example payload'
    })
  })

  it('claims no owned directory for a single-file torrent', async () => {
    const context = harness({
      files: [{ nextCursor: null, paths: ['clip.mp4'] }]
    })
    context.menu.open(INFO_HASH)

    click(context.template(), 'Remove Data File')
    await vi.waitFor(() => expect(context.deleted).toHaveLength(1))

    expect(context.deleted[0]).toMatchObject({ torrentDirectory: null })
  })

  it('never trashes a payload whose torrent could not be removed', async () => {
    const context = harness({ removeFails: true })
    context.menu.open(INFO_HASH)

    click(context.template(), 'Remove Data File')
    await vi.waitFor(() =>
      expect(
        context.executed.some(
          operation => operation.command === 'remove-torrent'
        )
      ).toBe(true)
    )

    expect(context.deleted).toEqual([])
  })
})
