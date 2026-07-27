import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { dock: null },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
    show(): void {}
  },
  powerSaveBlocker: { isStarted: () => false, start: () => 0, stop: () => {} }
}))

import type { Diagnostics } from './diagnostics'
import {
  DesktopNotifier,
  DockBadge,
  OS_INTEGRATION_LIMITS,
  PowerSaveGuard,
  StartupPreference
} from './os-integration'

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

describe('StartupPreference', () => {
  let openAtLogin = false

  beforeEach(() => {
    openAtLogin = false
  })

  function preference(failing = false): StartupPreference {
    return new StartupPreference({
      diagnostics: diagnostics(),
      electronApp: {
        getLoginItemSettings: () => {
          if (failing) throw new Error('unavailable')
          return { openAtLogin } as ReturnType<
            typeof import('electron').app.getLoginItemSettings
          >
        },
        setLoginItemSettings: settings => {
          if (failing) throw new Error('unavailable')
          openAtLogin = settings.openAtLogin === true
        }
      }
    })
  }

  it('reads and writes the login item', () => {
    const startup = preference()

    expect(startup.enabled()).toBe(false)
    expect(startup.set(true)).toBe(true)
    expect(startup.enabled()).toBe(true)
    expect(startup.set(false)).toBe(true)
    expect(startup.enabled()).toBe(false)
  })

  it('reports an unavailable login item without throwing', () => {
    const startup = preference(true)

    expect(startup.enabled()).toBe(false)
    expect(startup.set(true)).toBe(false)
  })
})

describe('PowerSaveGuard', () => {
  it('holds exactly one block while transfers are running', () => {
    const started: number[] = []
    const stopped: number[] = []
    let next = 1
    const guard = new PowerSaveGuard({
      blocker: {
        isStarted: () => true,
        start: () => {
          const handle = next
          next += 1
          started.push(handle)
          return handle
        },
        stop: handle => {
          stopped.push(handle)
          return true
        }
      },
      diagnostics: diagnostics()
    })

    guard.update(2)
    guard.update(3)
    expect(started).toEqual([1])
    expect(guard.active).toBe(true)

    guard.update(0)
    expect(stopped).toEqual([1])
    expect(guard.active).toBe(false)

    guard.release()
    expect(stopped).toEqual([1])
  })

  it('stays idle when the blocker cannot start', () => {
    const guard = new PowerSaveGuard({
      blocker: {
        isStarted: () => false,
        start: () => {
          throw new Error('unavailable')
        },
        stop: () => true
      },
      diagnostics: diagnostics()
    })

    guard.update(1)
    expect(guard.active).toBe(false)
  })
})

describe('DockBadge', () => {
  it('shows a bounded count and clears at zero', () => {
    const badges: string[] = []
    const badge = new DockBadge({
      dock: { setBadge: text => badges.push(text) }
    })

    badge.set(3)
    badge.set(0)
    badge.set(-1)
    badge.set(OS_INTEGRATION_LIMITS.maxBadgeCount + 10)
    badge.set(Number.NaN)

    expect(badges).toEqual([
      '3',
      '',
      '',
      String(OS_INTEGRATION_LIMITS.maxBadgeCount),
      ''
    ])
  })

  it('does nothing without a dock', () => {
    expect(() => new DockBadge({ dock: null }).set(2)).not.toThrow()
  })
})

describe('DesktopNotifier', () => {
  it('truncates and strips untrusted torrent text', () => {
    const shown: Array<{ body: string; title: string }> = []
    const notifier = new DesktopNotifier({
      diagnostics: diagnostics(),
      show: notification => shown.push(notification)
    })

    expect(
      notifier.notify({
        body: 'b'.repeat(OS_INTEGRATION_LIMITS.maxBodyLength + 50),
        title: 'Download complete'
      })
    ).toBe(true)

    expect(shown[0]?.title).toBe('Download complete')
    expect(shown[0]?.body).toHaveLength(OS_INTEGRATION_LIMITS.maxBodyLength)
    expect(shown[0]?.body.endsWith('…')).toBe(true)
  })

  it('sends nothing when disabled or empty', () => {
    const shown: unknown[] = []
    const disabled = new DesktopNotifier({
      diagnostics: diagnostics(),
      enabled: () => false,
      show: notification => shown.push(notification)
    })
    expect(disabled.notify({ body: 'x', title: 'Title' })).toBe(false)

    const enabled = new DesktopNotifier({
      diagnostics: diagnostics(),
      show: notification => shown.push(notification)
    })
    expect(enabled.notify({ body: 'x', title: '   ' })).toBe(false)
    expect(shown).toEqual([])
  })

  it('reports a failing notification without throwing', () => {
    const notifier = new DesktopNotifier({
      diagnostics: diagnostics(),
      show: () => {
        throw new Error('denied')
      }
    })

    expect(notifier.notify({ body: 'x', title: 'Title' })).toBe(false)
  })
})
