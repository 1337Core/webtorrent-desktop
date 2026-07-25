import { browser, expect } from '@wdio/globals'

/**
 * The packaged application must start with its security boundary intact and
 * its engine reachable. Every assertion here is about the artifact the owner
 * installs, not a development checkout.
 */
describe('WebTorrent Updated', () => {
  /**
   * The runtime is read through the app's own validated bridge rather than a
   * privileged automation channel: the packaged app exposes no CDP bridge, and
   * granting one to prove these facts would measure a different application.
   */
  it('runs an arm64 Electron 43 main process', async () => {
    const bootstrap = (await browser.execute(async () => {
      const desktop = (
        globalThis as unknown as {
          desktop: { getBootstrap: () => Promise<unknown> }
        }
      ).desktop
      return desktop.getBootstrap()
    })) as unknown as {
      ok?: boolean
      value?: {
        runtime?: {
          appName?: string
          architecture?: string
          electronVersion?: string
          nodeVersion?: string
          platform?: string
        }
      }
    }

    expect(bootstrap.ok).toBe(true)
    expect(bootstrap.value?.runtime?.architecture).toBe('arm64')
    expect(bootstrap.value?.runtime?.electronVersion).toBe('43.2.0')
    expect(bootstrap.value?.runtime?.nodeVersion).toBe('24.18.0')
    expect(bootstrap.value?.runtime?.appName).toBe('WebTorrent Updated')
    expect(bootstrap.value?.runtime?.platform).toBe('darwin')
  })

  it('serves the shell from its own locked application protocol', async () => {
    const pageUrl = await browser.execute(
      () =>
        (globalThis as unknown as { location: { href: string } }).location.href
    )

    expect(pageUrl).toBe('app://bundle/index.html')
  })

  it('renders the sandboxed application shell', async () => {
    await expect(browser.$('.header .title')).toHaveText('WebTorrent Updated')
    await expect(browser.$('[data-renderer-boundary]')).toHaveAttribute(
      'data-renderer-boundary',
      'passed'
    )
  })

  it('exposes no privileged globals to the renderer', async () => {
    const globals = (await browser.execute(() => ({
      buffer: typeof (globalThis as { Buffer?: unknown }).Buffer,
      capabilities: Object.keys(
        (globalThis as { desktop?: Record<string, unknown> }).desktop ?? {}
      ).sort(),
      process: typeof (globalThis as { process?: unknown }).process,
      require: typeof (globalThis as { require?: unknown }).require
    }))) as unknown as {
      buffer: string
      capabilities: string[]
      process: string
      require: string
    }

    expect(globals.buffer).toBe('undefined')
    expect(globals.process).toBe('undefined')
    expect(globals.require).toBe('undefined')
    expect(globals.capabilities).toEqual([
      'choosePath',
      'exportTorrent',
      'getBootstrap',
      'onEngineStatus',
      'onMenuAction',
      'onOpenIntent',
      'openExternalPlayer',
      'openTorrentMenu',
      'resolveDroppedTorrents',
      'restartEngine',
      'runTorrentCommand',
      'setPreferences'
    ])
  })

  it('reaches a ready engine with native WebRTC', async () => {
    await browser.waitUntil(
      async () =>
        (await browser
          .$('[data-engine-state]')
          .getAttribute('data-engine-state')) === 'ready',
      {
        timeout: 60_000,
        timeoutMsg: 'The engine did not become ready'
      }
    )

    const runtime = (await browser.execute(async () => {
      const desktop = (
        globalThis as unknown as {
          desktop: { getBootstrap: () => Promise<unknown> }
        }
      ).desktop
      return desktop.getBootstrap()
    })) as unknown as {
      value?: {
        engineStatusEvent?: {
          status?: { utpEnabled?: boolean; webRtcSupported?: boolean }
        }
      }
    }
    const status = runtime.value?.engineStatusEvent?.status

    expect(status?.webRtcSupported).toBe(true)
    expect(status?.utpEnabled).toBe(false)

    const torrents = await browser.execute(async () => {
      const desktop = (
        globalThis as unknown as {
          desktop: {
            runTorrentCommand: (operation: unknown) => Promise<unknown>
          }
        }
      ).desktop
      return desktop.runTorrentCommand({
        command: 'list-torrents',
        payload: { cursor: 0, limit: 50 }
      })
    })

    expect(JSON.stringify(torrents)).toContain('"ok":true')
  })
})
