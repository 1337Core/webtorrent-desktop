import { browser, expect } from '@wdio/globals'

/**
 * The packaged application must start with its security boundary intact and
 * its engine reachable. Every assertion here is about the artifact the owner
 * installs, not a development checkout.
 */
describe('WebTorrent Updated', () => {
  it('runs an arm64 Electron 43 main process', async () => {
    const versions = await browser.electron.execute(electron => ({
      arch: process.arch,
      electron: process.versions.electron,
      name: electron.app.getName(),
      node: process.versions.node,
      packaged: electron.app.isPackaged
    }))

    expect(versions.arch).toBe('arm64')
    expect(versions.electron).toBe('43.2.0')
    expect(versions.node).toBe('24.18.0')
    expect(versions.name).toBe('WebTorrent Updated')
    expect(versions.packaged).toBe(true)
  })

  it('renders the sandboxed application shell', async () => {
    await expect(browser.$('header .title')).toHaveText('WebTorrent Updated')
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
      'getBootstrap',
      'onEngineStatus',
      'onMenuAction',
      'onOpenIntent',
      'openExternalPlayer',
      'restartEngine',
      'runTorrentCommand',
      'setPreferences'
    ])
  })

  it('reaches a ready engine with native WebRTC', async () => {
    await browser.waitUntil(
      async () => {
        const label = await browser.$('[role="status"]').getText()
        return label.includes('native WebRTC ready')
      },
      {
        timeout: 60_000,
        timeoutMsg: 'The engine did not become ready'
      }
    )

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
