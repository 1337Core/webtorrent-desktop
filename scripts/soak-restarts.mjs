import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

/**
 * Section 18.5's supervised-restart soak.
 *
 * The development build is enough here: the workload is the main-process
 * supervisor and the real utility engine it forks, neither of which the
 * packaging step changes. The packaged artifact's own restart evidence stays
 * with `npm run smoke:package`.
 */

const execFile = promisify(execFileCallback)
const soakRunId = randomUUID()
const soakDirectoryPrefix = `webtorrent-updated-smoke-${soakRunId}-`
const root = resolve(import.meta.dirname, '..')
const RESTART_SOAK_TIMEOUT_MS = 360_000

async function removeSoakDirectories() {
  const entries = await readdir(tmpdir())
  for (const entry of entries) {
    if (!entry.startsWith(soakDirectoryPrefix)) continue
    const target = resolve(tmpdir(), entry)
    if (!target.startsWith(`${tmpdir()}${sep}`)) continue
    await rm(target, { force: true, recursive: true })
  }
}

function lastJsonLine(output) {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{') && line.endsWith('}'))
  const last = lines.at(-1)
  if (!last) throw new Error('The restart soak produced no result record')
  return JSON.parse(last)
}

let result
try {
  const { stdout } = await execFile(
    resolve(root, 'node_modules', '.bin', 'electron'),
    ['.', '--soak-restarts'],
    {
      cwd: root,
      env: {
        ...process.env,
        WEBTORRENT_UPDATED_SMOKE_RUN_ID: soakRunId
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: RESTART_SOAK_TIMEOUT_MS
    }
  )
  result = lastJsonLine(stdout)
} finally {
  await removeSoakDirectories()
}

if (result.result !== 'pass' || result.restarts !== 25) {
  console.error(JSON.stringify({ ...result, result: 'fail' }))
  process.exitCode = 1
} else {
  console.log(JSON.stringify(result))
}
