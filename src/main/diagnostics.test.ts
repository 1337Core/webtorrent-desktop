import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Diagnostics, redactText } from './diagnostics'

const temporaryDirectories: string[] = []

async function createDiagnostics(): Promise<{
  diagnostics: Diagnostics
  logPath: string
}> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'webtorrent-updated-diagnostics-')
  )
  temporaryDirectories.push(directory)

  return {
    diagnostics: new Diagnostics(directory),
    logPath: path.join(directory, 'application.jsonl')
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true }))
  )
})

describe('redactText', () => {
  it('removes torrent, credential, address, and local-path secrets', () => {
    const input = [
      'magnet:?xt=urn:btih:abcdef&dn=private',
      'https://user:password@tracker.example/a-passkey/announce?token=secret',
      'peer 203.0.113.7:6881',
      '/Users/alice/Downloads/private/movie.mp4',
      'token=loopback-secret'
    ].join(' ')

    const redacted = redactText(input)

    expect(redacted).not.toContain('abcdef')
    expect(redacted).not.toContain('password')
    expect(redacted).not.toContain('a-passkey')
    expect(redacted).not.toContain('203.0.113.7')
    expect(redacted).not.toContain('alice')
    expect(redacted).not.toContain('loopback-secret')
    expect(redacted).toContain('magnet:[redacted]')
    expect(redacted).toContain('[ip]')
    expect(redacted).toContain('[path]')
  })

  it('redacts bracketed and unbracketed IPv6 addresses', () => {
    const redacted = redactText(
      'public 2001:db8::1 loopback ::1 local [fe80::1]:6881'
    )

    expect(redacted).not.toContain('2001:db8::1')
    expect(redacted).not.toContain('::1')
    expect(redacted).not.toContain('fe80::1')
    expect(redacted.match(/\[ip\]/gu)).toHaveLength(3)
  })

  it('redacts short, quoted, and home-relative absolute paths', () => {
    const redacted = redactText(
      `/x /tmp/x /etc/hosts ~/x "/Users/a/My Videos/private.mp4"`
    )

    expect(redacted).not.toContain('/x')
    expect(redacted).not.toContain('/tmp/x')
    expect(redacted).not.toContain('/etc/hosts')
    expect(redacted).not.toContain('~/x')
    expect(redacted).not.toContain('My Videos')
    expect(redacted.match(/\[path\]/gu)).toHaveLength(5)
  })

  it('removes control and directional characters used for log injection', () => {
    const redacted = redactText(
      'safe\n{"level":"error"}\r\u0000\u2028\u202eend'
    )

    expect(
      Array.from(redacted).every(character => {
        const codePoint = character.codePointAt(0) ?? 0
        return !(
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x2028 ||
          codePoint === 0x2029
        )
      })
    ).toBe(true)
    expect(redacted).not.toContain('\n')
    expect(redacted).not.toContain('\r')
    expect(redacted).not.toContain('\u202e')
  })

  it('bounds logged strings', () => {
    expect(redactText('a'.repeat(4096))).toHaveLength(2048)
  })
})

describe('Diagnostics', () => {
  it('keeps each record valid and within the four-KiB byte budget', async () => {
    const { diagnostics, logPath } = await createDiagnostics()
    const oversizedDetails = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `field-${index}`,
        '🦄'.repeat(2048)
      ])
    )

    diagnostics.info('oversized-record', oversizedDetails)
    await diagnostics.flush()

    const line = await readFile(logPath, 'utf8')
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4 * 1024)
    expect(JSON.parse(line)).toMatchObject({
      code: 'oversized-record',
      details: {
        truncated: true
      }
    })
  })

  it('writes injected content as one sanitized NDJSON record', async () => {
    const { diagnostics, logPath } = await createDiagnostics()

    diagnostics.error('bad\ncode', {
      message: 'first\r\n{"code":"forged"}',
      token: 'loopback-secret',
      filePath: '/x'
    })
    await diagnostics.flush()

    const contents = await readFile(logPath, 'utf8')
    const lines = contents.trimEnd().split('\n')
    const record = JSON.parse(lines[0] ?? '')

    expect(lines).toHaveLength(1)
    expect(contents).not.toContain('loopback-secret')
    expect(contents).not.toContain('/x')
    expect(record.code).toBe('bad code')
    expect(record.details).toMatchObject({
      token: '[redacted]',
      filePath: '[redacted]'
    })
  })

  it('bounds queued records and reports dropped diagnostics', async () => {
    const { diagnostics, logPath } = await createDiagnostics()

    for (let index = 0; index < 2000; index += 1) {
      diagnostics.info('queue-test', { index })
    }
    await diagnostics.flush()

    const records = (await readFile(logPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as { code: string })

    expect(records.length).toBeLessThanOrEqual(258)
    expect(
      records.some(record => record.code === 'diagnostics.records-dropped')
    ).toBe(true)
  })
})
