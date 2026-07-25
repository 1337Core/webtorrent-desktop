import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

/**
 * Milestone 7's automatable half.
 *
 * The application the owner runs is a copy living outside this checkout, and
 * replacing it must be a matter of swapping the bundle. This copies the
 * packaged `.app` to a temporary location, launches it there, replaces it with
 * a second copy, and launches it again — proving the artifact does not depend
 * on the repository it was built in and survives manual replacement.
 *
 * What it cannot prove is the owner's own use: real handlers, playback, and a
 * preserved personal profile across the swap. Those stay owner-verified.
 */
const APP_NAME = 'WebTorrent Updated'
const root = resolve(import.meta.dirname, '..')
const packagedApp = resolve(
  root,
  'out',
  `${APP_NAME}-darwin-arm64`,
  `${APP_NAME}.app`
)

async function launch(installedApp) {
  const executable = resolve(installedApp, 'Contents', 'MacOS', APP_NAME)
  const { stdout } = await execFile(executable, ['--m2-smoke'], {
    timeout: 120_000
  })
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  if (
    result.result !== 'pass' ||
    result.architecture !== 'arm64' ||
    result.engineRuntime?.webRtcSupported !== true ||
    result.engineRuntime?.utpEnabled !== false
  ) {
    throw new Error(
      `Installed application did not qualify: ${JSON.stringify(result)}`
    )
  }
  return result
}

const installRoot = await mkdtemp(
  resolve(tmpdir(), 'webtorrent-updated-install-')
)
// The install must not sit inside the checkout it was built from.
if (installRoot.startsWith(`${root}${sep}`)) {
  throw new Error('The qualification install must live outside the checkout')
}
const installedApp = resolve(installRoot, basename(packagedApp))

try {
  await cp(packagedApp, installedApp, {
    recursive: true,
    verbatimSymlinks: true
  })
  const first = await launch(installedApp)

  // Manual replacement: the same swap the owner performs to update.
  await rm(installedApp, { force: true, recursive: true })
  await cp(packagedApp, installedApp, {
    recursive: true,
    verbatimSymlinks: true
  })
  const second = await launch(installedApp)

  console.log(
    JSON.stringify({
      installRoot,
      launches: [first.scenario, second.scenario],
      replaced: true,
      result: 'pass'
    })
  )
} finally {
  await rm(installRoot, { force: true, recursive: true })
}
