import path from 'node:path'

const APP_NAME = 'WebTorrent Updated'
const PACKAGED_APP = path.resolve(
  'out',
  `${APP_NAME}-darwin-arm64`,
  `${APP_NAME}.app`,
  'Contents',
  'MacOS',
  APP_NAME
)

/**
 * Desktop end-to-end configuration.
 *
 * The suite drives the packaged arm64 application, never a development
 * checkout, so what it exercises is exactly what the owner installs. Globals
 * are not injected: every spec imports what it uses.
 */
export const config: WebdriverIO.Config = {
  bail: 1,
  capabilities: [
    {
      browserName: 'electron',
      // The driver must match the Chromium the packaged app actually reports,
      // not the newest published Chrome: `Chrome/150.0.7871.129` in this
      // Electron 43.2.0 build.
      browserVersion: '150.0.7871.129',
      'wdio:electronServiceOptions': {
        appBinaryPath: PACKAGED_APP,
        appArgs: ['--e2e']
      }
    }
  ],
  connectionRetryCount: 1,
  connectionRetryTimeout: 120_000,
  framework: 'mocha',
  injectGlobals: false,
  logLevel: 'warn',
  maxInstances: 1,
  mochaOpts: {
    timeout: 120_000,
    ui: 'bdd'
  },
  reporters: ['spec'],
  runner: 'local',
  services: ['electron'],
  specs: ['./e2e/**/*.e2e.ts'],
  waitforTimeout: 30_000
}
