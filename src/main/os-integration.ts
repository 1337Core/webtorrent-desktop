import { app, Notification, powerSaveBlocker } from 'electron'
import type { Diagnostics } from './diagnostics'

export const OS_INTEGRATION_LIMITS = Object.freeze({
  maxBadgeCount: 999,
  maxBodyLength: 256,
  maxTitleLength: 128
})

/**
 * Whether the application opens at login. macOS owns the setting; this only
 * reads and writes it, and never enables it on the owner's behalf.
 */
export class StartupPreference {
  readonly #diagnostics: Diagnostics
  readonly #electronApp: Pick<
    typeof app,
    'getLoginItemSettings' | 'setLoginItemSettings'
  >

  constructor(
    options: Readonly<{
      diagnostics: Diagnostics
      electronApp?: Pick<
        typeof app,
        'getLoginItemSettings' | 'setLoginItemSettings'
      >
    }>
  ) {
    this.#diagnostics = options.diagnostics
    this.#electronApp = options.electronApp ?? app
  }

  enabled(): boolean {
    try {
      return this.#electronApp.getLoginItemSettings().openAtLogin === true
    } catch {
      this.#diagnostics.warn('startup.read-failed')
      return false
    }
  }

  set(enabled: boolean): boolean {
    try {
      this.#electronApp.setLoginItemSettings({
        openAsHidden: enabled,
        openAtLogin: enabled
      })
      return this.enabled() === enabled
    } catch {
      this.#diagnostics.warn('startup.write-failed')
      return false
    }
  }
}

/**
 * Holds a power-save block only while work is actually running, so an idle
 * app never keeps the Mac awake.
 */
export class PowerSaveGuard {
  readonly #blocker: Pick<
    typeof powerSaveBlocker,
    'isStarted' | 'start' | 'stop'
  >
  readonly #diagnostics: Diagnostics
  #handle: number | null = null

  constructor(
    options: Readonly<{
      blocker?: Pick<typeof powerSaveBlocker, 'isStarted' | 'start' | 'stop'>
      diagnostics: Diagnostics
    }>
  ) {
    this.#blocker = options.blocker ?? powerSaveBlocker
    this.#diagnostics = options.diagnostics
  }

  get active(): boolean {
    return this.#handle !== null
  }

  /** Idempotent: repeated updates never stack blockers. */
  update(activeTransfers: number): void {
    const wanted = Number.isSafeInteger(activeTransfers) && activeTransfers > 0
    if (wanted === this.active) return

    if (wanted) {
      try {
        this.#handle = this.#blocker.start('prevent-app-suspension')
      } catch {
        this.#diagnostics.warn('power-save.start-failed')
        this.#handle = null
      }
      return
    }
    this.release()
  }

  release(): void {
    const handle = this.#handle
    this.#handle = null
    if (handle === null) return
    try {
      if (this.#blocker.isStarted(handle)) this.#blocker.stop(handle)
    } catch {
      this.#diagnostics.warn('power-save.stop-failed')
    }
  }
}

/** The dock badge only ever shows a bounded count of active torrents. */
export class DockBadge {
  readonly #dock: { setBadge: (text: string) => void } | null

  constructor(
    options: Readonly<{
      dock?: { setBadge: (text: string) => void } | null
    }> = {}
  ) {
    this.#dock = options.dock === undefined ? (app.dock ?? null) : options.dock
  }

  set(count: number): void {
    if (!this.#dock) return
    const bounded =
      !Number.isSafeInteger(count) || count <= 0
        ? 0
        : Math.min(count, OS_INTEGRATION_LIMITS.maxBadgeCount)
    this.#dock.setBadge(bounded === 0 ? '' : String(bounded))
  }
}

export type DesktopNotification = Readonly<{ body: string; title: string }>

/**
 * Local notifications only. Text is truncated and stripped of control
 * characters because torrent names are untrusted input.
 */
export class DesktopNotifier {
  readonly #diagnostics: Diagnostics
  readonly #enabled: () => boolean
  readonly #show: (notification: DesktopNotification) => void

  constructor(
    options: Readonly<{
      diagnostics: Diagnostics
      enabled?: () => boolean
      show?: (notification: DesktopNotification) => void
    }>
  ) {
    this.#diagnostics = options.diagnostics
    this.#enabled = options.enabled ?? (() => true)
    this.#show =
      options.show ??
      (notification => {
        if (!Notification.isSupported()) return
        new Notification({
          body: notification.body,
          silent: false,
          title: notification.title
        }).show()
      })
  }

  notify(notification: DesktopNotification): boolean {
    if (!this.#enabled()) return false

    const title = sanitize(
      notification.title,
      OS_INTEGRATION_LIMITS.maxTitleLength
    )
    const body = sanitize(
      notification.body,
      OS_INTEGRATION_LIMITS.maxBodyLength
    )
    if (title === '') return false

    try {
      this.#show({ body, title })
      return true
    } catch {
      this.#diagnostics.warn('notification.failed')
      return false
    }
  }
}

function sanitize(value: string, maximum: number): string {
  if (typeof value !== 'string') return ''
  const stripped = [...value]
    .filter(character => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()
  return stripped.length > maximum
    ? `${stripped.slice(0, maximum - 1)}…`
    : stripped
}
