import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire
} from '@electron/fuses'
import { extractFile, listPackage } from '@electron/asar'

const execFile = promisify(execFileCallback)
const root = resolve(import.meta.dirname, '..')
const appPath = resolve(
  root,
  'out',
  'WebTorrent Updated-darwin-arm64',
  'WebTorrent Updated.app'
)
const resourcesPath = resolve(appPath, 'Contents', 'Resources')
const asarPath = resolve(resourcesPath, 'app.asar')
const nativePath = resolve(
  resourcesPath,
  'app.asar.unpacked',
  'node_modules',
  'node-datachannel',
  'build',
  'Release',
  'node_datachannel.node'
)
const expectedNativeHash =
  '1d4f814bede82a5412b19e8973e44eb484d504acc52f17796e90add75dc9ac80'
const exactVersionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const sourceManifest = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8')
)
const requiredRuntimeDependencies = new Map(
  Object.entries(sourceManifest.dependencies ?? {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )
)

if (requiredRuntimeDependencies.size === 0) {
  throw new Error('Source manifest must declare runtime dependencies')
}
for (const [dependency, expectedVersion] of requiredRuntimeDependencies) {
  if (
    typeof expectedVersion !== 'string' ||
    !exactVersionPattern.test(expectedVersion)
  ) {
    throw new Error(
      `Runtime dependency ${dependency} must use an exact semantic version`
    )
  }
}

async function collectNativeModules(directory) {
  const found = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await collectNativeModules(entryPath)))
    } else if (entry.name.endsWith('.node')) {
      found.push(entryPath)
    }
  }
  return found
}

async function collectExecutableFiles(directory) {
  const found = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await collectExecutableFiles(entryPath)))
    } else if (entry.isFile() && ((await stat(entryPath)).mode & 0o111) !== 0) {
      found.push(entryPath)
    }
  }
  return found
}

async function plistValue(key, format = 'raw') {
  const infoPlist = resolve(appPath, 'Contents', 'Info.plist')
  const { stdout } = await execFile('plutil', [
    '-extract',
    key,
    format,
    '-o',
    '-',
    infoPlist
  ])
  return stdout.trim()
}

async function plistKeyExists(key) {
  try {
    await plistValue(key)
    return true
  } catch {
    return false
  }
}

await access(asarPath)
await access(nativePath)

const packageFiles = listPackage(asarPath)
const requiredPackageFiles = [
  '/LICENSE',
  '/build/engine/index.mjs',
  '/build/main/index.mjs',
  '/build/preload/index.cjs',
  '/build/renderer/index.html',
  ...[...requiredRuntimeDependencies.keys()].map(
    dependency => `/node_modules/${dependency}/package.json`
  ),
  '/package.json'
]
for (const requiredPath of requiredPackageFiles) {
  if (!packageFiles.includes(requiredPath)) {
    throw new Error(`Required ASAR path is missing: ${requiredPath}`)
  }
}

const forbiddenPackagePaths = [
  '/.github',
  '/index.js',
  '/src',
  '/node_modules/@electron/remote',
  '/node_modules/spectron',
  '/build/main/index.cjs'
]
for (const forbiddenPath of forbiddenPackagePaths) {
  if (
    packageFiles.some(
      packagePath =>
        packagePath === forbiddenPath ||
        packagePath.startsWith(`${forbiddenPath}/`)
    )
  ) {
    throw new Error(`Forbidden ASAR path is present: ${forbiddenPath}`)
  }
}

const appOwnedPackageFiles = packageFiles.filter(
  packagePath => !packagePath.startsWith('/node_modules/')
)
const appOwnedTestFile = appOwnedPackageFiles.find(
  packagePath =>
    /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/u.test(packagePath) ||
    /\.(?:spec|test)\.[^/]+$/u.test(packagePath)
)
if (appOwnedTestFile) {
  throw new Error(`App-owned test artifact is present: ${appOwnedTestFile}`)
}
const appBuildSourceMap = appOwnedPackageFiles.find(
  packagePath =>
    packagePath.startsWith('/build/') && packagePath.endsWith('.map')
)
if (appBuildSourceMap) {
  throw new Error(
    `Application build source map is present: ${appBuildSourceMap}`
  )
}

const packagedManifest = JSON.parse(
  extractFile(asarPath, 'package.json').toString('utf8')
)
if (
  packagedManifest.name !== 'webtorrent-updated' ||
  packagedManifest.main !== 'build/main/index.mjs'
) {
  throw new Error(
    'Packaged manifest does not match the pinned runtime contract'
  )
}
const packagedRuntimeDependencies = packagedManifest.dependencies ?? {}
const packagedDependencyNames = Object.keys(packagedRuntimeDependencies).sort()
const expectedDependencyNames = [...requiredRuntimeDependencies.keys()]
if (
  packagedDependencyNames.length !== expectedDependencyNames.length ||
  packagedDependencyNames.some(
    (dependency, index) => dependency !== expectedDependencyNames[index]
  )
) {
  throw new Error(
    `Packaged runtime dependency manifest differs from source:\nexpected ${expectedDependencyNames.join(', ')}\nreceived ${packagedDependencyNames.join(', ')}`
  )
}
for (const [dependency, expectedVersion] of requiredRuntimeDependencies) {
  if (packagedRuntimeDependencies[dependency] !== expectedVersion) {
    throw new Error(
      `Packaged manifest must pin ${dependency} to ${expectedVersion}`
    )
  }

  const dependencyManifestPath = `node_modules/${dependency}/package.json`
  const dependencyManifest = JSON.parse(
    extractFile(asarPath, dependencyManifestPath).toString('utf8')
  )
  if (
    dependencyManifest.name !== dependency ||
    dependencyManifest.version !== expectedVersion
  ) {
    throw new Error(
      `Packaged ${dependency} manifest does not match ${expectedVersion}`
    )
  }
}

const mainBundle = extractFile(asarPath, 'build/main/index.mjs').toString(
  'utf8'
)
const preloadBundle = extractFile(asarPath, 'build/preload/index.cjs').toString(
  'utf8'
)
const rendererBundlePath = packageFiles.find(packagePath =>
  /^\/build\/renderer\/assets\/index-[^/]+\.js$/u.test(packagePath)
)
if (!rendererBundlePath) {
  throw new Error('Packaged renderer JavaScript bundle is missing or ambiguous')
}
const rendererBundle = extractFile(
  asarPath,
  rendererBundlePath.slice(1)
).toString('utf8')

for (const requiredMarker of [
  'desktop:bootstrap:v1',
  'desktop:engine-restart:v1',
  'desktop:engine-status:v1',
  'webtorrent-updated-ui'
]) {
  if (!mainBundle.includes(requiredMarker)) {
    throw new Error(`Main trust-boundary marker is missing: ${requiredMarker}`)
  }
}
for (const requiredMarker of [
  'desktop:bootstrap:v1',
  'desktop:engine-restart:v1',
  'desktop:engine-status:v1',
  'exposeInMainWorld'
]) {
  if (!preloadBundle.includes(requiredMarker)) {
    throw new Error(`Preload capability marker is missing: ${requiredMarker}`)
  }
}
for (const forbiddenMarker of [
  '@electron/remote',
  'electron-store',
  'ipcRenderer',
  'node:fs',
  'webtorrent'
]) {
  if (rendererBundle.includes(forbiddenMarker)) {
    throw new Error(
      `Renderer bundle contains a privileged marker: ${forbiddenMarker}`
    )
  }
}

const nativeModules = await collectNativeModules(resourcesPath)
if (nativeModules.length !== 1 || resolve(nativeModules[0]) !== nativePath) {
  throw new Error(
    `Unexpected packaged native modules:\n${nativeModules.join('\n')}`
  )
}

const nativeBuffer = await readFile(nativePath)
const nativeHash = createHash('sha256').update(nativeBuffer).digest('hex')
if (nativeHash !== expectedNativeHash) {
  throw new Error(
    `node-datachannel hash mismatch: ${nativeHash} != ${expectedNativeHash}`
  )
}

const executableFiles = await collectExecutableFiles(appPath)
let machOBinaryCount = 0
for (const binaryPath of executableFiles) {
  const { stdout } = await execFile('file', [binaryPath])
  if (!stdout.includes('Mach-O')) continue

  machOBinaryCount += 1
  if (!stdout.includes('arm64') || stdout.includes('x86_64')) {
    throw new Error(`Unexpected binary architecture: ${stdout.trim()}`)
  }
}
if (machOBinaryCount === 0) {
  throw new Error('No Mach-O binaries found in packaged application')
}

await execFile('codesign', [
  '--verify',
  '--deep',
  '--strict',
  '--verbose=4',
  appPath
])

if (
  (await plistValue('CFBundleIdentifier')) !==
  'local.webtorrent-updated.desktop'
) {
  throw new Error('Unexpected bundle identifier')
}
if ((await plistValue('CFBundleVersion')) !== '1.0.0') {
  throw new Error('CFBundleVersion must remain numeric')
}
if (
  (await plistValue('NSAppTransportSecurity.NSAllowsArbitraryLoads')) !==
  'false'
) {
  throw new Error('Arbitrary network loads must remain disabled')
}
for (const permissionKey of [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]) {
  if (await plistKeyExists(permissionKey)) {
    throw new Error(`Unexpected macOS permission declaration: ${permissionKey}`)
  }
}

const { stdout: entitlementOutput, stderr: entitlementDiagnostics } =
  await execFile('codesign', ['-d', '--entitlements', '-', appPath])
const entitlements = `${entitlementOutput}\n${entitlementDiagnostics}`
for (const dangerousEntitlement of [
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
  'com.apple.security.network.server'
]) {
  if (entitlements.includes(dangerousEntitlement)) {
    throw new Error(`Dangerous entitlement is present: ${dangerousEntitlement}`)
  }
}

const integrity = JSON.parse(await plistValue('ElectronAsarIntegrity', 'json'))
if (!integrity['Resources/app.asar']?.hash) {
  throw new Error('ASAR integrity metadata is missing')
}

const fuses = await getCurrentFuseWire(appPath)
const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
])

if (fuses.version !== FuseVersion.V1) {
  throw new Error(`Unexpected fuse wire version: ${fuses.version}`)
}
for (const [fuse, expected] of expectedFuses) {
  if (fuses[fuse] !== expected) {
    throw new Error(`Unexpected ${FuseV1Options[fuse]} fuse state`)
  }
}

console.log(
  JSON.stringify({
    app: appPath,
    architecture: 'arm64',
    bundleId: 'local.webtorrent-updated.desktop',
    asarEntryCount: packageFiles.length,
    machOBinaryCount,
    nativeHash,
    result: 'pass'
  })
)
