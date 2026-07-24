const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses')
const {
  AutoUnpackNativesPlugin
} = require('@electron-forge/plugin-auto-unpack-natives')

const APP_NAME = 'WebTorrent Updated'
const OPTIONAL_NATIVE_PACKAGES = new Set([
  'bufferutil',
  'fs-native-extensions',
  'utf-8-validate',
  'utp-native'
])
const EXPECTED_NATIVE_SUFFIX =
  '/node_modules/node-datachannel/build/Release/node_datachannel.node'

function assertToolchain() {
  const npmVersion = execFileSync('npm', ['--version'], {
    encoding: 'utf8'
  }).trim()

  if (process.versions.node !== '24.18.0' || npmVersion !== '11.16.0') {
    throw new Error(
      `Expected Node 24.18.0/npm 11.16.0, received Node ${process.versions.node}/npm ${npmVersion}`
    )
  }
}

assertToolchain()

function buildApplication() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build.mjs'], {
      cwd: __dirname,
      stdio: 'inherit'
    })

    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`Application build exited with code ${code}`))
    })
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed: ${stderr || error.message}`
          )
        )
      } else {
        resolve(stdout)
      }
    })
  })
}

async function findAppBundle(startPath) {
  let current = startPath
  while (current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current
    current = path.dirname(current)
  }

  const entries = await fs.readdir(startPath, { withFileTypes: true })
  const app = entries.find(
    entry => entry.isDirectory() && entry.name.endsWith('.app')
  )
  if (!app) throw new Error(`No app bundle found under ${startPath}`)
  return path.join(startPath, app.name)
}

async function walk(root, visitor) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    await visitor(entryPath, entry)
    if (entry.isDirectory()) await walk(entryPath, visitor)
  }
}

async function flipApplicationFuses(
  _forgeConfig,
  buildPath,
  _electronVersion,
  platform,
  arch
) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(`Unsupported package target: ${platform}-${arch}`)
  }

  const appPath = await findAppBundle(buildPath)
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: true,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  })
}

async function pruneNativePackages(
  _forgeConfig,
  buildPath,
  _electronVersion,
  platform,
  arch
) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(`Unsupported package target: ${platform}-${arch}`)
  }

  await run(
    'npm',
    ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: buildPath }
  )

  const removals = []
  await walk(buildPath, async (entryPath, entry) => {
    if (
      entry.isDirectory() &&
      OPTIONAL_NATIVE_PACKAGES.has(entry.name) &&
      path.basename(path.dirname(entryPath)) === 'node_modules'
    ) {
      removals.push(entryPath)
    }
  })
  await Promise.all(
    removals.map(packagePath =>
      fs.rm(packagePath, {
        force: true,
        recursive: true
      })
    )
  )

  const nativeModules = []
  await walk(buildPath, async (entryPath, entry) => {
    if (entry.isFile() && entry.name.endsWith('.node')) {
      nativeModules.push(entryPath)
    }
  })

  if (
    nativeModules.length !== 1 ||
    !nativeModules[0].replaceAll(path.sep, '/').endsWith(EXPECTED_NATIVE_SUFFIX)
  ) {
    throw new Error(
      `Unexpected native module inventory:\n${nativeModules.join('\n') || '(empty)'}`
    )
  }
}

async function finalizeLocalApp(_forgeConfig, packageResult) {
  for (const outputPath of packageResult.outputPaths) {
    const appPath = await findAppBundle(outputPath)
    const infoPlist = path.join(appPath, 'Contents', 'Info.plist')

    for (const key of [
      'NSAudioCaptureUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSBluetoothPeripheralUsageDescription',
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription'
    ]) {
      try {
        await run('plutil', ['-remove', key, infoPlist])
      } catch {
        // Electron may stop shipping a permission key in a future release.
      }
    }

    await run('plutil', [
      '-replace',
      'NSAppTransportSecurity',
      '-json',
      '{"NSAllowsArbitraryLoads":false}',
      infoPlist
    ])
    await run('codesign', ['--force', '--deep', '--sign', '-', appPath])
    await run('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=4',
      appPath
    ])
  }
}

function ignorePackagePath(filePath) {
  const normalized = filePath.replaceAll(path.sep, '/')
  if (normalized === '' || normalized === '/') return false

  return !['/LICENSE', '/build', '/node_modules', '/package.json'].some(
    allowedPath =>
      normalized === allowedPath || normalized.startsWith(`${allowedPath}/`)
  )
}

module.exports = {
  packagerConfig: {
    appBundleId: 'local.webtorrent-updated.desktop',
    appCategoryType: 'public.app-category.utilities',
    arch: 'arm64',
    asar: true,
    buildVersion: '1.0.0',
    download: {
      checksums: {
        'electron-v43.2.0-darwin-arm64.zip':
          'ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28'
      }
    },
    executableName: APP_NAME,
    icon: path.join(__dirname, 'static', 'WebTorrent'),
    ignore: ignorePackagePath,
    name: APP_NAME,
    osxUniversal: false,
    platform: 'darwin'
  },
  rebuildConfig: {
    onlyModules: ['node-datachannel']
  },
  makers: [],
  hooks: {
    packageAfterCopy: flipApplicationFuses,
    packageAfterPrune: pruneNativePackages,
    postPackage: finalizeLocalApp,
    prePackage: buildApplication,
    preStart: buildApplication
  },
  plugins: [new AutoUnpackNativesPlugin({})]
}
