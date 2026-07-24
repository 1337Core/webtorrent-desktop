import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
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

const { stdout } = await execFile(executable, ['--m1-smoke'], {
  timeout: 45_000
})
const lines = stdout.trim().split('\n')
const result = JSON.parse(lines.at(-1) ?? '{}')

if (
  result.result !== 'pass' ||
  result.architecture !== 'arm64' ||
  result.electron !== '43.2.0' ||
  result.node !== '24.18.0' ||
  result.renderer !== 'ready' ||
  result.engine?.processType !== 'utility' ||
  result.engine?.utpEnabled !== false ||
  result.engine?.webRtcSupported !== true ||
  result.engine?.webTorrentVersion !== '3.0.16'
) {
  throw new Error(`Packaged smoke failed: ${JSON.stringify(result)}`)
}

console.log(JSON.stringify(result))
