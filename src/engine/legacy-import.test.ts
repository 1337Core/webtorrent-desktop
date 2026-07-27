import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bencode from 'bencode'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LegacyImporter,
  LegacyImportError,
  LEGACY_IMPORT_LIMITS
} from './legacy-import'
import { EgressPolicy } from './network-policy'

let root = ''
let importer: LegacyImporter

function torrentBytes(
  options: {
    announce?: string
    files?: Array<{ length: number; path: string[] }>
    name?: string
    private?: boolean
  } = {}
): Uint8Array {
  return bencode.encode({
    announce: options.announce ?? 'https://tracker.example/announce',
    info: {
      files: options.files ?? [
        { length: 10, path: ['first.bin'] },
        { length: 10, path: ['second.bin'] }
      ],
      name: options.name ?? 'legacy-payload',
      'piece length': 16_384,
      pieces: new Uint8Array(20),
      ...(options.private ? { private: 1 } : {})
    }
  })
}

async function writeLegacy(
  state: Record<string, unknown>,
  torrents: Record<string, Uint8Array> = {}
): Promise<void> {
  await writeFile(
    path.join(root, LEGACY_IMPORT_LIMITS.stateFile),
    JSON.stringify(state)
  )
  await mkdir(path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory), {
    recursive: true
  })
  for (const [name, bytes] of Object.entries(torrents)) {
    await writeFile(
      path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory, name),
      bytes
    )
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-legacy-'))
  importer = new LegacyImporter({ policy: new EgressPolicy(), root })
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('LegacyImporter', () => {
  it('rejects a relative legacy root', () => {
    expect(
      () => new LegacyImporter({ policy: new EgressPolicy(), root: 'x' })
    ).toThrow(LegacyImportError)
  })

  it('reports an unreadable or absent legacy profile', async () => {
    await expect(importer.scan()).rejects.toMatchObject({
      code: 'STATE_UNREADABLE'
    })

    await writeFile(path.join(root, LEGACY_IMPORT_LIMITS.stateFile), '[]')
    await expect(importer.scan()).rejects.toMatchObject({
      code: 'STATE_UNREADABLE'
    })
  })

  it('imports a valid torrent with its saved selection and leaves the profile untouched', async () => {
    const bytes = torrentBytes()
    await writeLegacy(
      {
        prefs: {
          autoAddTorrents: true,
          downloadPath: '/Users/owner/Downloads',
          externalPlayerPath: 'relative/vlc',
          soundNotifications: false
        },
        torrents: [
          {
            displayName: 'Legacy One',
            selections: [false, true],
            torrentFileName: 'one.torrent'
          }
        ],
        version: '0.24.0'
      },
      { 'one.torrent': bytes }
    )

    const before = await readFile(
      path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory, 'one.torrent')
    )
    const report = await importer.scan()

    expect(report.scannedTorrentCount).toBe(1)
    expect(report.version).toBe('0.24.0')
    expect(report.preferences).toEqual({
      autoAddTorrents: true,
      downloadPath: '/Users/owner/Downloads',
      externalPlayerPath: null,
      highestPlaybackPriority: true,
      openExternalPlayer: false,
      soundNotifications: false,
      startup: false,
      torrentsFolderPath: null
    })
    expect(report.entries[0]).toMatchObject({
      kind: 'importable',
      name: 'Legacy One',
      selectedPaths: ['legacy-payload/second.bin']
    })

    // Read-only: the legacy bytes are byte-for-byte unchanged.
    expect(
      await readFile(
        path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory, 'one.torrent')
      )
    ).toEqual(before)
  })

  it('selects everything when the saved selection cannot be trusted', async () => {
    await writeLegacy(
      {
        torrents: [
          { selections: [true], torrentFileName: 'a.torrent' },
          { selections: [false, false], torrentFileName: 'b.torrent' }
        ]
      },
      {
        'a.torrent': torrentBytes({ name: 'alpha' }),
        'b.torrent': torrentBytes({ name: 'beta' })
      }
    )

    const report = await importer.scan()
    expect(report.entries).toEqual([
      expect.objectContaining({
        selectedPaths: ['alpha/first.bin', 'alpha/second.bin']
      }),
      expect.objectContaining({
        selectedPaths: ['beta/first.bin', 'beta/second.bin']
      })
    ])
  })

  it('skips missing, malformed, duplicate, and unsupported entries', async () => {
    await writeLegacy(
      {
        torrents: [
          { displayName: 'Absent', torrentFileName: 'absent.torrent' },
          { displayName: 'Escaping', torrentFileName: '../escape.torrent' },
          { displayName: 'Broken', torrentFileName: 'broken.torrent' },
          { displayName: 'First', torrentFileName: 'one.torrent' },
          { displayName: 'Repeat', torrentFileName: 'one-copy.torrent' },
          'not-an-object'
        ]
      },
      {
        'broken.torrent': new Uint8Array([0x64, 0x65]),
        'one-copy.torrent': torrentBytes(),
        'one.torrent': torrentBytes()
      }
    )

    const report = await importer.scan()
    expect(
      report.entries.map(entry =>
        entry.kind === 'skipped' ? entry.reason : 'importable'
      )
    ).toEqual([
      'TORRENT_FILE_MISSING',
      'INVALID_ENTRY',
      'INVALID_METADATA',
      'importable',
      'DUPLICATE',
      'INVALID_ENTRY'
    ])
  })

  it('reports a trackerless private torrent as skipped rather than runnable', async () => {
    await writeLegacy(
      { torrents: [{ displayName: 'Private', torrentFileName: 'p.torrent' }] },
      {
        'p.torrent': bencode.encode({
          info: {
            length: 10,
            name: 'private-payload',
            'piece length': 16_384,
            pieces: new Uint8Array(20),
            private: 1
          }
        })
      }
    )

    const report = await importer.scan()
    expect(report.entries[0]).toEqual({
      kind: 'skipped',
      name: 'Private',
      reason: 'PRIVATE_WITHOUT_TRACKER'
    })
  })

  it('refuses to follow a symlinked legacy file', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wu-legacy-outside-'))
    try {
      await writeFile(path.join(outside, 'real.torrent'), torrentBytes())
      await writeLegacy(
        {
          torrents: [{ displayName: 'Linked', torrentFileName: 'link.torrent' }]
        },
        {}
      )
      await symlink(
        path.join(outside, 'real.torrent'),
        path.join(root, LEGACY_IMPORT_LIMITS.torrentDirectory, 'link.torrent')
      )

      const report = await importer.scan()
      expect(report.entries[0]).toMatchObject({
        kind: 'skipped',
        reason: 'TORRENT_FILE_MISSING'
      })
    } finally {
      await rm(outside, { force: true, recursive: true })
    }
  })

  it('refuses a profile with too many torrents', async () => {
    await writeLegacy({
      torrents: Array.from(
        { length: LEGACY_IMPORT_LIMITS.maxTorrents + 1 },
        () => ({ torrentFileName: 'one.torrent' })
      )
    })

    await expect(importer.scan()).rejects.toMatchObject({
      code: 'TOO_MANY_TORRENTS'
    })
  })
})
