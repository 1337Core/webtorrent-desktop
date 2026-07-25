import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }
}))

import type { MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '../shared/contracts'
import { buildAppMenuTemplate, type AppMenuActions } from './app-menu'

function actions(): AppMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    addTorrent: vi.fn(),
    createTorrent: vi.fn(),
    openPreferences: vi.fn(),
    quit: vi.fn(),
    toggleFullScreen: vi.fn()
  }
}

function labels(items: MenuItemConstructorOptions[] | undefined): string[] {
  return (items ?? [])
    .map(item => item.label ?? item.role ?? item.type ?? '')
    .filter(label => label !== '')
}

function submenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  const found = template.find(item => item.label === label)?.submenu
  return Array.isArray(found) ? found : []
}

describe('buildAppMenuTemplate', () => {
  it('builds the fixed macOS menu without removed features', () => {
    const template = buildAppMenuTemplate({
      actions: actions(),
      developer: false
    })

    expect(labels(template)).toEqual([
      APP_NAME,
      'File',
      'Edit',
      'View',
      'Window'
    ])
    const flattened = JSON.stringify(template).toLowerCase()
    for (const removed of [
      'cast',
      'chromecast',
      'airplay',
      'dlna',
      'telemetry',
      'check for update',
      'announcement',
      'poster'
    ]) {
      expect(flattened).not.toContain(removed)
    }
  })

  it('wires each action exactly once', () => {
    const wired = actions()
    const template = buildAppMenuTemplate({ actions: wired, developer: false })

    const file = submenu(template, 'File')
    file
      .find(item => item.label === 'Add Torrent…')
      ?.click?.(undefined as never, undefined, undefined as never)
    file
      .find(item => item.label === 'Create Torrent…')
      ?.click?.(undefined as never, undefined, undefined as never)
    submenu(template, APP_NAME)
      .find(item => item.label === 'Preferences…')
      ?.click?.(undefined as never, undefined, undefined as never)

    expect(wired.addTorrent).toHaveBeenCalledOnce()
    expect(wired.createTorrent).toHaveBeenCalledOnce()
    expect(wired.openPreferences).toHaveBeenCalledOnce()
    expect(wired.quit).not.toHaveBeenCalled()
  })

  it('exposes developer tools only in a development build', () => {
    const release = buildAppMenuTemplate({
      actions: actions(),
      developer: false
    })
    const development = buildAppMenuTemplate({
      actions: actions(),
      developer: true
    })

    expect(labels(submenu(release, 'View'))).toEqual(['Toggle Full Screen'])
    expect(labels(submenu(development, 'View'))).toContain('toggleDevTools')
    expect(labels(submenu(development, 'View'))).toContain('reload')
  })
})
