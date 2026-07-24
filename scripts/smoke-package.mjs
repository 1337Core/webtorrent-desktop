import {
  execFile as execFileCallback,
  spawn as spawnCallback
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const smokeRunId = randomUUID()
const smokeDirectoryPrefix = `webtorrent-updated-smoke-${smokeRunId}-`
const smokeEnvironment = {
  ...process.env,
  WEBTORRENT_UPDATED_SMOKE_RUN_ID: smokeRunId
}
const root = resolve(import.meta.dirname, '..')
const executable = resolve(
  root,
  'out',
  'WebTorrent Updated-darwin-arm64',
  'WebTorrent Updated.app',
  'Contents',
  'MacOS',
  'WebTorrent Updated'
)
const scenarios = [
  {
    argument: '--m2-smoke',
    expected: 'baseline'
  },
  {
    argument: '--m2-smoke-restart',
    expected: 'restart'
  },
  {
    argument: '--m2-smoke-crash-loop',
    expected: 'crash-loop'
  }
]
const results = []

async function pathExists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function expectRejectedLaunch(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawnCallback(executable, ['--m2-smoke', ...arguments_], {
      env: smokeEnvironment,
      stdio: 'ignore'
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(
        new Error(`Dangerous launch did not exit: ${arguments_.join(' ')}`)
      )
    }, 10_000)

    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 1 && signal === null) {
        resolve()
        return
      }
      reject(
        new Error(
          `Dangerous launch had unexpected exit ${String(code)}/${String(signal)}: ${arguments_.join(' ')}`
        )
      )
    })
  })
}

async function smokeDataDirectories() {
  const entries = await readdir(tmpdir(), { withFileTypes: true })
  return new Set(
    entries
      .filter(
        entry =>
          entry.isDirectory() && entry.name.startsWith(smokeDirectoryPrefix)
      )
      .map(entry => entry.name)
  )
}

for (const scenario of scenarios) {
  const { stdout } = await execFile(executable, [scenario.argument], {
    env: smokeEnvironment,
    timeout: 60_000
  })
  const lines = stdout.trim().split('\n')
  const result = JSON.parse(lines.at(-1) ?? '{}')

  if (
    result.result !== 'pass' ||
    result.scenario !== scenario.expected ||
    result.architecture !== 'arm64' ||
    result.electron !== '43.2.0' ||
    result.node !== '24.18.0' ||
    result.protocolVersion !== 1 ||
    result.renderer?.bootstrapCommitted !== true ||
    result.renderer?.bufferPresent !== false ||
    result.renderer?.desktopApiKeys?.join(',') !==
      'getBootstrap,onEngineStatus,restartEngine' ||
    result.renderer?.navigationDenied !== true ||
    result.renderer?.networkFetchDenied !== true ||
    result.renderer?.pageUrl !== 'app://bundle/index.html' ||
    result.renderer?.permissionState !== 'denied' ||
    result.renderer?.popupDenied !== true ||
    result.renderer?.processPresent !== false ||
    result.renderer?.rendererBoundary !== 'passed' ||
    result.renderer?.requirePresent !== false ||
    result.renderer?.webRtcBlocked !== true ||
    result.renderer?.webRtcErrorName !== 'NotAllowedError' ||
    result.engineRuntime?.processType !== 'utility' ||
    result.engineRuntime?.utpEnabled !== false ||
    result.engineRuntime?.webRtcSupported !== true ||
    result.engineRuntime?.webTorrentVersion !== '3.0.16' ||
    result.trustBoundaries?.contextIsolation !== true ||
    result.trustBoundaries?.dedicatedUiSession !== true ||
    !result.trustBoundaries?.connectionAllowlist?.includes('webrtc=block') ||
    result.trustBoundaries?.dnsPrefetchControl !== 'off' ||
    result.trustBoundaries?.nodeIntegration !== false ||
    result.trustBoundaries?.osSandboxed !== true ||
    result.trustBoundaries?.preloadMainFrame !== true ||
    result.trustBoundaries?.sandbox !== true ||
    result.trustBoundaries?.sessionPersistent !== false ||
    result.trustBoundaries?.sessionStoragePath !== null ||
    result.smokeDataIsolated !== true ||
    typeof result.smokeDataRoot !== 'string'
  ) {
    throw new Error(
      `Packaged ${scenario.expected} smoke failed: ${JSON.stringify(result)}`
    )
  }

  const resolvedSmokeRoot = resolve(result.smokeDataRoot)
  const resolvedTemporaryRoot = `${resolve(tmpdir())}${sep}`
  if (
    !resolvedSmokeRoot.startsWith(resolvedTemporaryRoot) ||
    !basename(resolvedSmokeRoot).startsWith(smokeDirectoryPrefix) ||
    (await pathExists(resolvedSmokeRoot))
  ) {
    throw new Error(
      `Packaged ${scenario.expected} smoke data was not isolated and removed: ${JSON.stringify(result)}`
    )
  }

  if (
    scenario.expected === 'baseline' &&
    (result.forcedCrashes !== 0 ||
      result.engine?.state !== 'ready' ||
      !Number.isSafeInteger(result.engineProcessId))
  ) {
    throw new Error(
      `Packaged baseline state was invalid: ${JSON.stringify(result)}`
    )
  }
  if (
    scenario.expected === 'restart' &&
    (result.forcedCrashes !== 1 ||
      result.engine?.state !== 'ready' ||
      result.engine?.restartCount !== 1 ||
      !Number.isSafeInteger(result.engineProcessId))
  ) {
    throw new Error(
      `Packaged restart state was invalid: ${JSON.stringify(result)}`
    )
  }
  if (
    scenario.expected === 'crash-loop' &&
    (result.forcedCrashes !== 2 ||
      result.engine?.state !== 'stopped' ||
      result.engine?.code !== 'ENGINE_CRASH_LOOP' ||
      result.engineProcessId !== null)
  ) {
    throw new Error(
      `Packaged crash-loop state was invalid: ${JSON.stringify(result)}`
    )
  }
  if (
    Number.isSafeInteger(result.engineProcessId) &&
    processExists(result.engineProcessId)
  ) {
    throw new Error(
      `Packaged ${scenario.expected} left its utility process running: ${JSON.stringify(result)}`
    )
  }

  results.push({
    forcedCrashes: result.forcedCrashes,
    scenario: result.scenario,
    state: result.engine.state
  })
}

const rejectedLaunches = [
  ['--disable-web-security=1'],
  ['--no-sandbox=true'],
  ['--remote-debugging-pipe=1'],
  ['--remote-debugging-port', '9222']
]
const smokeDirectoriesBeforeRejectedLaunches = await smokeDataDirectories()
for (const launchArguments of rejectedLaunches) {
  await expectRejectedLaunch(launchArguments)
}
const leakedSmokeDirectories = [...(await smokeDataDirectories())].filter(
  name => !smokeDirectoriesBeforeRejectedLaunches.has(name)
)
for (const directoryName of leakedSmokeDirectories) {
  const directory = resolve(tmpdir(), directoryName)
  if (
    !directory.startsWith(`${resolve(tmpdir())}${sep}`) ||
    !basename(directory).startsWith(smokeDirectoryPrefix)
  ) {
    throw new Error(`Refusing to remove an unowned smoke path: ${directory}`)
  }
  await rm(directory, { force: true, recursive: true })
  if (await pathExists(directory)) {
    throw new Error(`Rejected-launch smoke data was not removed: ${directory}`)
  }
}

console.log(
  JSON.stringify({
    architecture: 'arm64',
    abnormalLaunchDirectoriesCleaned: leakedSmokeDirectories.length,
    dangerousLaunchesRejected: rejectedLaunches.length,
    result: 'pass',
    scenarios: results
  })
)
