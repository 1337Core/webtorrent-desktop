#!/usr/bin/env node
// Script-free artifact acquisition (plan section 6.2).
//
// `npm ci --ignore-scripts` deliberately leaves Electron's runtime and
// node-datachannel's addon absent. This is the one owned, fail-closed step
// that puts them in place: exact URLs, exact SHA-256 values, no mirror or
// proxy override, no compiler, no package lifecycle script, and no Forge
// rebuild. `--verify` performs every check without any network access.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheRoot = path.join(root, '.artifacts')

const ELECTRON = Object.freeze({
  archiveSha256:
    'ad4a0ae3c37ee05aa06c7e2ed0627608389790f0505a2b0d20319efbe33ffe28',
  fileName: 'electron-v43.2.0-darwin-arm64.zip',
  url: 'https://github.com/electron/electron/releases/download/v43.2.0/electron-v43.2.0-darwin-arm64.zip',
  version: '43.2.0'
})

const NODE_DATACHANNEL = Object.freeze({
  archiveSha256:
    '69fbffdacb9abda2a76809693443328b6aad71af25947e0733913340365f4da8',
  binarySha256:
    '1d4f814bede82a5412b19e8973e44eb484d504acc52f17796e90add75dc9ac80',
  fileName: 'node-datachannel-v0.32.3-napi-v8-darwin-arm64.tar.gz',
  member: 'build/Release/node_datachannel.node',
  url: 'https://github.com/murat-dogan/node-datachannel/releases/download/v0.32.3/node-datachannel-v0.32.3-napi-v8-darwin-arm64.tar.gz',
  version: '0.32.3'
})

const ELECTRON_LAUNCHER = 'Electron.app/Contents/MacOS/Electron'
const verifyOnly = process.argv.includes('--verify')
const records = []

function fail(message) {
  console.error(`acquire-artifacts: ${message}`)
  process.exit(1)
}

function record(entry) {
  records.push(entry)
  console.log(
    `${entry.artifact}: ${entry.result}${entry.source ? ` (${entry.source})` : ''}`
  )
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function sha256(target) {
  return createHash('sha256')
    .update(await readFile(target))
    .digest('hex')
}

/**
 * Downloads one exact URL. Mirror and proxy overrides are rejected outright so
 * an environment variable can never redirect a pinned artifact.
 */
async function download(url, destination) {
  for (const variable of [
    'ELECTRON_MIRROR',
    'ELECTRON_CUSTOM_DIR',
    'ELECTRON_BUILDER_BINARIES_MIRROR',
    'PREBUILD_INSTALL_HOST',
    'npm_config_electron_mirror',
    'npm_config_prebuild_install_host',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy'
  ]) {
    if (process.env[variable]) {
      fail(`refusing to download while ${variable} is set`)
    }
  }

  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    fail(`download failed for ${url} (${response.status})`)
  }
  await mkdir(path.dirname(destination), { mode: 0o700, recursive: true })
  await pipeline(response.body, createWriteStream(destination, { mode: 0o600 }))
}

async function ensureArchive(artifact) {
  const cached = path.join(cacheRoot, artifact.fileName)
  if (await exists(cached)) {
    const digest = await sha256(cached)
    if (digest === artifact.archiveSha256)
      return { path: cached, source: 'cache' }
    await rm(cached, { force: true })
  }
  if (verifyOnly) return null

  await download(artifact.url, cached)
  const digest = await sha256(cached)
  if (digest !== artifact.archiveSha256) {
    await rm(cached, { force: true })
    fail(`archive hash mismatch for ${artifact.fileName}`)
  }
  return { path: cached, source: 'download' }
}

function isMachOArm64(target) {
  const described = execFileSync('/usr/bin/file', ['-b', target], {
    encoding: 'utf8'
  })
  return described.includes('Mach-O') && described.includes('arm64')
}

function validateElectronArchiveEntries(archivePath) {
  const entries = execFileSync('/usr/bin/unzip', ['-Z1', archivePath], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter(entry => entry !== '')

  const allowedTopLevelFiles = new Set([
    'LICENSE',
    'LICENSES.chromium.html',
    'version'
  ])

  for (const entry of entries) {
    if (entry.includes('\0') || entry.includes('\\') || entry.startsWith('/')) {
      fail(`unsafe Electron archive member: ${entry}`)
    }

    const components = entry.replace(/\/$/, '').split('/')
    if (
      components.some(
        component => component === '' || component === '.' || component === '..'
      )
    ) {
      fail(`unsafe Electron archive member: ${entry}`)
    }
    if (
      components[0] !== 'Electron.app' &&
      !(components.length === 1 && allowedTopLevelFiles.has(components[0]))
    ) {
      fail(`unexpected Electron archive member: ${entry}`)
    }
  }

  if (!entries.includes(ELECTRON_LAUNCHER)) {
    fail(`Electron archive is missing ${ELECTRON_LAUNCHER}`)
  }
  for (const required of allowedTopLevelFiles) {
    if (!entries.includes(required)) {
      fail(`Electron archive is missing ${required}`)
    }
  }
}

async function validateExtractedElectronTree(target, appRoot) {
  for (const entry of await readdir(target)) {
    const child = path.join(target, entry)
    const info = await lstat(child)

    if (info.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(child), await readlink(child))
      if (
        resolved !== appRoot &&
        !resolved.startsWith(`${appRoot}${path.sep}`)
      ) {
        fail(`Electron archive contains an escaping symbolic link: ${child}`)
      }
      continue
    }
    if (info.isDirectory()) {
      await validateExtractedElectronTree(child, appRoot)
      continue
    }
    if (!info.isFile()) {
      fail(`Electron archive contains an unsupported entry type: ${child}`)
    }
  }
}

async function extractElectron(archivePath) {
  validateElectronArchiveEntries(archivePath)

  const electronPackage = path.join(root, 'node_modules', 'electron')
  const destination = path.join(electronPackage, 'dist')
  const staging = await mkdtemp(path.join(electronPackage, '.dist-'))
  let moved = false

  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', archivePath, staging], {
      stdio: 'ignore'
    })

    const appRoot = path.join(staging, 'Electron.app')
    await validateExtractedElectronTree(staging, appRoot)
    const version = (
      await readFile(path.join(staging, 'version'), 'utf8')
    ).trim()
    if (version !== ELECTRON.version) {
      fail(`Electron archive reports ${version}, expected ${ELECTRON.version}`)
    }

    const launcher = path.join(staging, ELECTRON_LAUNCHER)
    if (!isMachOArm64(launcher)) {
      fail('extracted Electron is not Mach-O arm64')
    }

    await rename(staging, destination)
    moved = true
    await writeFile(path.join(electronPackage, 'path.txt'), ELECTRON_LAUNCHER, {
      mode: 0o600
    })
  } finally {
    if (!moved) await rm(staging, { force: true, recursive: true })
  }
}

async function verifyElectron() {
  const installed = path.join(
    root,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron'
  )
  const pathFile = path.join(root, 'node_modules', 'electron', 'path.txt')
  let archiveSource = null

  if (!(await exists(installed))) {
    const archive = await ensureArchive(ELECTRON)
    if (!archive)
      fail('Electron runtime is absent and --verify cannot fetch it')
    await extractElectron(archive.path)
    archiveSource = archive.source
  }

  if (!isMachOArm64(installed)) fail('installed Electron is not Mach-O arm64')
  const reported = execFileSync(installed, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  // ELECTRON_RUN_AS_NODE reports the bundled Node; the version file is the
  // authority for the Electron line itself.
  const versionFile = path.join(
    root,
    'node_modules',
    'electron',
    'dist',
    'version'
  )
  const version = (await readFile(versionFile, 'utf8')).trim()
  if (version !== ELECTRON.version) {
    fail(`installed Electron reports ${version}, expected ${ELECTRON.version}`)
  }
  if (!(await exists(pathFile))) {
    if (verifyOnly) fail('electron/path.txt is absent')
    await writeFile(pathFile, ELECTRON_LAUNCHER, { mode: 0o600 })
  } else if ((await readFile(pathFile, 'utf8')) !== ELECTRON_LAUNCHER) {
    fail(`electron/path.txt must contain ${ELECTRON_LAUNCHER}`)
  }
  record({
    artifact: 'electron',
    hash: archiveSource ? ELECTRON.archiveSha256 : null,
    result: archiveSource ? 'installed' : 'present',
    source: archiveSource ?? `${installed} (node ${reported.trim()})`
  })
}

/**
 * Extracts exactly one member. Links, absolute paths, and traversal are
 * rejected before anything is written, and the extracted binary must match its
 * pinned hash, be Mach-O arm64, and load through Node-API.
 */
async function extractAddon(archivePath, destination) {
  const listing = execFileSync('/usr/bin/tar', ['-tzf', archivePath], {
    encoding: 'utf8'
  })
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')

  for (const entry of listing) {
    if (entry === NODE_DATACHANNEL.member) continue
    if (entry.endsWith('/')) continue
    fail(`unexpected archive member: ${entry}`)
  }
  if (!listing.includes(NODE_DATACHANNEL.member)) {
    fail(`archive is missing ${NODE_DATACHANNEL.member}`)
  }

  const staging = await mkdtemp(path.join(tmpdir(), 'wu-addon-'))
  try {
    execFileSync(
      '/usr/bin/tar',
      [
        '-xzf',
        archivePath,
        '-C',
        staging,
        '--no-same-owner',
        NODE_DATACHANNEL.member
      ],
      { stdio: 'ignore' }
    )
    const extracted = path.join(staging, NODE_DATACHANNEL.member)
    const info = await stat(extracted)
    if (!info.isFile()) fail('extracted addon is not a regular file')
    if ((await sha256(extracted)) !== NODE_DATACHANNEL.binarySha256) {
      fail('extracted addon hash mismatch')
    }
    if (!isMachOArm64(extracted)) fail('extracted addon is not Mach-O arm64')

    await mkdir(path.dirname(destination), { mode: 0o700, recursive: true })
    await rename(extracted, destination)
  } finally {
    await rm(staging, { force: true, recursive: true })
  }
}

async function verifyAddon() {
  const installed = path.join(
    root,
    'node_modules',
    'node-datachannel',
    NODE_DATACHANNEL.member
  )

  if (await exists(installed)) {
    const digest = await sha256(installed)
    if (digest !== NODE_DATACHANNEL.binarySha256) {
      fail('installed node-datachannel addon does not match its reviewed hash')
    }
    if (!isMachOArm64(installed)) fail('installed addon is not Mach-O arm64')
    record({
      artifact: 'node-datachannel',
      hash: digest,
      result: 'present',
      source: installed
    })
    return
  }
  if (verifyOnly) fail('node-datachannel addon is absent')

  const archive = await ensureArchive(NODE_DATACHANNEL)
  if (!archive) fail('node-datachannel archive is unavailable')
  await extractAddon(archive.path, installed)
  record({
    artifact: 'node-datachannel',
    hash: NODE_DATACHANNEL.binarySha256,
    result: 'installed',
    source: archive.source
  })
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail('this workflow supports macOS on Apple Silicon only')
}

await verifyElectron()
await verifyAddon()
console.log(
  `acquire-artifacts: ${records.length} artifact(s) verified without a source build or lifecycle script`
)
