import { createHash } from 'node:crypto'
import bencode from 'bencode'
import parseTorrent from 'parse-torrent'
import { describe, expect, it } from 'vitest'
import { EgressPolicy } from './network-policy'
import { scanStrictTorrentBencode } from './strict-bencode'
import {
  prepareMagnet,
  TorrentInputError,
  validateTorrentMetadata
} from './torrent-metadata'

const policy = new EgressPolicy()

function singleFileTorrent(
  options: {
    announce?: string
    info?: Record<string, unknown>
    topLevel?: Record<string, unknown>
  } = {}
): Uint8Array {
  return bencode.encode({
    announce: options.announce ?? 'https://tracker.example/announce',
    ...options.topLevel,
    info: {
      length: 1,
      name: 'safe.txt',
      'piece length': 16_384,
      pieces: new Uint8Array(20),
      ...options.info
    }
  })
}

describe('validateTorrentMetadata', () => {
  it('hashes the exact canonical info dictionary and returns a bounded manifest', async () => {
    const bytes = singleFileTorrent()
    const result = await validateTorrentMetadata(bytes, policy)
    const parsed = await parseTorrent(bytes)
    const scan = scanStrictTorrentBencode(bytes)

    expect(result).toMatchObject({
      announceTiers: [['https://tracker.example/announce']],
      files: [
        {
          index: 0,
          length: 1,
          offset: 0,
          path: 'safe.txt'
        }
      ],
      infoHash: parsed.infoHash,
      length: 1,
      name: 'safe.txt',
      pieceCount: 1,
      pieceLength: 16_384,
      private: false
    })
    expect(
      createHash('sha1')
        .update(bytes.subarray(scan.infoStart, scan.infoEnd))
        .digest('hex')
    ).toBe(result.infoHash)
  })

  it('preserves tracker tiers while removing disabled UDP transport', async () => {
    const bytes = singleFileTorrent({
      topLevel: {
        'announce-list': [
          [
            'udp://tracker.example:6969/announce',
            'https://one.example/announce'
          ],
          ['wss://two.example/announce']
        ],
        'url-list': ['https://seed.example/content', 'file:///private/content']
      }
    })

    const result = await validateTorrentMetadata(bytes, policy)

    expect(result.announceTiers).toEqual([
      ['https://one.example/announce'],
      ['wss://two.example/announce']
    ])
    expect(result.webSeeds).toEqual(['https://seed.example/content'])
    expect(result.warnings).toEqual([
      'TRACKER_TRANSPORT_DISABLED',
      'WEB_SEED_INVALID'
    ])
  })

  it('uses the primary announce URL when an announce list is empty', async () => {
    await expect(
      validateTorrentMetadata(
        singleFileTorrent({
          topLevel: {
            'announce-list': []
          }
        }),
        policy
      )
    ).resolves.toMatchObject({
      announceTiers: [['https://tracker.example/announce']]
    })
  })

  it('requires a usable tracker for private metadata', async () => {
    const bytes = singleFileTorrent({
      announce: 'udp://tracker.example:6969/announce',
      info: { private: 1 }
    })

    await expect(validateTorrentMetadata(bytes, policy)).rejects.toMatchObject({
      code: 'PRIVATE_TRACKER_REQUIRED'
    })
  })

  it.each([
    [{ 'meta version': 2 }, {}, 'UNSUPPORTED_V2'],
    [{ 'file tree': {} }, {}, 'UNSUPPORTED_V2'],
    [{}, { 'piece layers': {} }, 'UNSUPPORTED_V2']
  ])(
    'rejects v2 or hybrid fields before commit',
    async (info, topLevel, code) => {
      await expect(
        validateTorrentMetadata(singleFileTorrent({ info, topLevel }), policy)
      ).rejects.toMatchObject({ code })
    }
  )

  it('rejects unsafe, ambiguous, and case-folded-colliding paths', async () => {
    const bytes = singleFileTorrent({
      info: {
        files: [
          { length: 0, path: ['Movie.mkv'] },
          { length: 1, path: ['movie.mkv'] }
        ],
        length: undefined
      }
    })

    await expect(validateTorrentMetadata(bytes, policy)).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    })

    const traversal = singleFileTorrent({
      info: {
        files: [{ length: 1, path: ['..', 'escape'] }],
        length: undefined
      }
    })
    await expect(
      validateTorrentMetadata(traversal, policy)
    ).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    })

    const fileDirectoryCollision = singleFileTorrent({
      info: {
        files: [
          { length: 0, path: ['a'] },
          { length: 1, path: ['a', 'b'] }
        ],
        length: undefined
      }
    })
    await expect(
      validateTorrentMetadata(fileDirectoryCollision, policy)
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })

  it.each([
    ['Greek final sigma', 'aς.txt', 'aσ.txt'],
    ['German sharp s', 'aß.txt', 'ass.txt'],
    ['German capital sharp s', 'aẞ.txt', 'ass.txt'],
    ['canonical normalization', 'café.txt', 'cafe\u0301.txt']
  ])('rejects APFS %s collisions', async (_label, first, second) => {
    const bytes = singleFileTorrent({
      info: {
        files: [
          { length: 0, path: [first] },
          { length: 1, path: [second] }
        ],
        length: undefined
      }
    })

    await expect(validateTorrentMetadata(bytes, policy)).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    })
  })

  it('does not collapse distinct APFS accents', async () => {
    const bytes = singleFileTorrent({
      info: {
        files: [
          { length: 0, path: ['resume.txt'] },
          { length: 1, path: ['résumé.txt'] }
        ],
        length: undefined
      }
    })

    await expect(validateTorrentMetadata(bytes, policy)).resolves.toMatchObject(
      {
        files: [
          { path: 'safe.txt/resume.txt' },
          { path: 'safe.txt/résumé.txt' }
        ]
      }
    )
  })

  it('accepts a zero-length v1 file with zero pieces', async () => {
    const result = await validateTorrentMetadata(
      singleFileTorrent({
        info: {
          length: 0,
          pieces: new Uint8Array()
        }
      }),
      policy
    )

    expect(result.length).toBe(0)
    expect(result.pieceCount).toBe(0)
  })

  it('rejects inconsistent piece geometry and invalid private flags', async () => {
    await expect(
      validateTorrentMetadata(
        singleFileTorrent({ info: { pieces: new Uint8Array(40) } }),
        policy
      )
    ).rejects.toMatchObject({ code: 'INVALID_METADATA' })
    await expect(
      validateTorrentMetadata(
        singleFileTorrent({ info: { private: 2 } }),
        policy
      )
    ).rejects.toMatchObject({ code: 'INVALID_METADATA' })
  })

  it('counts tracker and web-seed inputs before filtering unsupported URLs', async () => {
    await expect(
      validateTorrentMetadata(
        singleFileTorrent({
          topLevel: {
            'announce-list': Array.from({ length: 65 }, (_, index) => [
              `udp://tracker-${index}.example:6969/announce`
            ])
          }
        }),
        policy
      )
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })

    await expect(
      validateTorrentMetadata(
        singleFileTorrent({
          topLevel: {
            'url-list': Array.from(
              { length: 33 },
              (_, index) => `file:///private/${index}`
            )
          }
        }),
        policy
      )
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('accepts valid non-power-of-two v1 piece geometry', async () => {
    await expect(
      validateTorrentMetadata(
        singleFileTorrent({
          info: {
            'piece length': 12_000
          }
        }),
        policy
      )
    ).resolves.toMatchObject({ pieceLength: 12_000 })
  })

  it('binds staged metadata to the magnet info hash', async () => {
    const bytes = singleFileTorrent()
    const result = await validateTorrentMetadata(bytes, policy)

    await expect(
      validateTorrentMetadata(bytes, policy, {
        expectedInfoHash: result.infoHash
      })
    ).resolves.toMatchObject({ infoHash: result.infoHash })
    await expect(
      validateTorrentMetadata(bytes, policy, {
        expectedInfoHash: '0'.repeat(40)
      })
    ).rejects.toMatchObject({ code: 'INFO_HASH_MISMATCH' })
  })

  it('rejects bencode dictionaries whose decoded prototype was poisoned', async () => {
    const prefix = new TextEncoder().encode(
      'd4:infod9:__proto__d1:ai1ee6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:'
    )
    const suffix = new TextEncoder().encode('ee')
    const bytes = new Uint8Array(prefix.byteLength + 20 + suffix.byteLength)
    bytes.set(prefix)
    bytes.set(suffix, prefix.byteLength + 20)

    await expect(validateTorrentMetadata(bytes, policy)).rejects.toMatchObject({
      code: 'INVALID_METADATA'
    })
  })
})

describe('prepareMagnet', () => {
  it('strips exact sources and peer addresses while preserving bounded selection', async () => {
    const result = await prepareMagnet(
      [
        'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
        'tr=https%3A%2F%2Ftracker.example%2Fannounce',
        'xs=https%3A%2F%2Fsource.example%2Ffile.torrent',
        'x.pe=127.0.0.1%3A6881',
        'so=0-2%2C5'
      ].join('&'),
      policy,
      { allowDht: false }
    )

    expect(result).toMatchObject({
      dhtEnabled: false,
      infoHash: '0123456789abcdef0123456789abcdef01234567',
      selection: [0, 1, 2, 5],
      trackers: ['https://tracker.example/announce'],
      xsRemoved: true
    })
    expect(result.magnet.xs).toBeUndefined()
    expect(result.magnet.peerAddresses).toEqual([])
    expect(result.magnetUri).not.toContain('xs=')
    expect(result.magnetUri).not.toContain('x.pe=')
  })

  it('requires explicit consent before trackerless DHT metadata discovery', async () => {
    const magnet =
      'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

    await expect(
      prepareMagnet(magnet, policy, { allowDht: false })
    ).rejects.toMatchObject({ code: 'DHT_CONSENT_REQUIRED' })
    await expect(
      prepareMagnet(magnet, policy, { allowDht: true })
    ).resolves.toMatchObject({ dhtEnabled: true })
  })

  it('rejects pure-v2 and hybrid exact topics', async () => {
    const btmh = `urn:btmh:1220${'a'.repeat(64)}`
    await expect(
      prepareMagnet(`magnet:?xt=${btmh}`, policy, { allowDht: true })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_V2' })
    await expect(
      prepareMagnet(
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&xt=${btmh}`,
        policy,
        { allowDht: true }
      )
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_V2' })
  })

  it('accepts base32 btih and rejects every duplicate exact topic', async () => {
    await expect(
      prepareMagnet(`magnet:?xt=urn:btih:${'A'.repeat(32)}`, policy, {
        allowDht: true
      })
    ).resolves.toMatchObject({ infoHash: '0'.repeat(40) })

    for (const duplicate of ['A'.repeat(32), 'B'.repeat(32)]) {
      await expect(
        prepareMagnet(
          `magnet:?xt=urn:btih:${'0'.repeat(40)}&xt=urn:btih:${duplicate}`,
          policy,
          { allowDht: true }
        )
      ).rejects.toMatchObject({ code: 'INVALID_MAGNET' })
    }
  })

  it('rejects hostile BEP 53 expansion before parse-torrent sees it', async () => {
    await expect(
      prepareMagnet(
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&so=0-1000000000`,
        policy,
        { allowDht: true }
      )
    ).rejects.toBeInstanceOf(TorrentInputError)
    await expect(
      prepareMagnet(
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&so=0-1000000000`,
        policy,
        { allowDht: true }
      )
    ).rejects.toMatchObject({ code: 'INVALID_MAGNET' })
  })

  it('counts repeated BEP 53 range expansion before deduplication', async () => {
    await expect(
      prepareMagnet(
        `magnet:?xt=urn:btih:${'a'.repeat(40)}&so=${[
          '0-49999',
          '0-49999',
          '0-49999'
        ].join('%2C')}`,
        policy,
        { allowDht: true }
      )
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})
