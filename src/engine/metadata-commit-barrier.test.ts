import bencode from 'bencode'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  runMetadataCommitBarrier,
  type CommitBarrierObservation
} from './metadata-commit-barrier'
import { EgressPolicy } from './network-policy'
import {
  validateTorrentMetadata,
  type ValidatedTorrentMetadata
} from './torrent-metadata'
import { TorrentRegistry, type TorrentReservation } from './torrent-registry'

const policy = new EgressPolicy()

function torrentBytes(
  options: { info?: Record<string, unknown> } = {}
): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    'announce-list': [
      ['https://tracker.example/announce', 'https://backup.example/announce']
    ],
    info: {
      files: [
        { length: 6, path: ['first.bin'] },
        { length: 10, path: ['nested', 'second.bin'] }
      ],
      name: 'payload',
      'piece length': 16_384,
      pieces: new Uint8Array(20),
      ...options.info
    }
  })
}

function observationFor(
  metadata: ValidatedTorrentMetadata,
  overrides: Partial<CommitBarrierObservation> = {}
): CommitBarrierObservation {
  return {
    files: metadata.files.map(file => ({
      length: file.length,
      path: file.path
    })),
    infoHash: metadata.infoHash,
    length: metadata.length,
    name: metadata.name,
    pieceLength: metadata.pieceLength,
    private: metadata.private,
    torrentFile: metadata.torrentBytes,
    ...overrides
  }
}

function reservationFor(
  metadata: ValidatedTorrentMetadata
): TorrentReservation {
  return new TorrentRegistry().reserve({
    fileCount: metadata.files.length,
    infoHash: metadata.infoHash,
    owner: 'public'
  })
}

let metadata: ValidatedTorrentMetadata
let reservation: TorrentReservation

beforeAll(async () => {
  metadata = await validateTorrentMetadata(torrentBytes(), policy)
  reservation = reservationFor(metadata)
})

describe('runMetadataCommitBarrier', () => {
  it('commits when every retained identity field matches', () => {
    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata),
        reservation
      })
    ).toEqual({ ok: true })
  })

  it('accepts metadata whose tracker topology WebTorrent reconstructed', async () => {
    // parse-torrent flattens announce-list and toTorrentFile() rebuilds
    // singleton tiers, so the barrier must not compare tracker topology.
    const rebuilt = bencode.decode(metadata.torrentBytes) as Record<
      string,
      unknown
    >
    rebuilt['announce-list'] = [
      ['https://tracker.example/announce'],
      ['https://backup.example/announce']
    ]

    const result = runMetadataCommitBarrier({
      expected: metadata,
      observed: observationFor(metadata, {
        torrentFile: bencode.encode(rebuilt)
      }),
      reservation
    })
    expect(result).toEqual({ ok: true })
  })

  it('refuses a torrent whose canonical info hash left the reservation', async () => {
    const other = await validateTorrentMetadata(
      torrentBytes({ info: { name: 'different' } }),
      policy
    )

    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata, {
          torrentFile: other.torrentBytes
        }),
        reservation
      })
    ).toMatchObject({ code: 'INFO_HASH_MISMATCH', ok: false })

    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata, { infoHash: other.infoHash }),
        reservation
      })
    ).toMatchObject({ code: 'INFO_HASH_MISMATCH', ok: false })
  })

  it('refuses a reservation that does not describe the expected metadata', () => {
    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata),
        reservation: { ...reservation, fileCount: 99 }
      })
    ).toMatchObject({ code: 'RESERVATION_MISMATCH', ok: false })
  })

  it('refuses mismatched name, privacy, geometry, and file manifest', () => {
    const cases: Array<[Partial<CommitBarrierObservation>, string]> = [
      [{ name: 'renamed' }, 'NAME_MISMATCH'],
      [{ private: true }, 'PRIVACY_MISMATCH'],
      [{ pieceLength: 32_768 }, 'GEOMETRY_MISMATCH'],
      [{ length: 15 }, 'GEOMETRY_MISMATCH'],
      [
        {
          files: [{ length: 6, path: 'payload/first.bin' }]
        },
        'FILE_MANIFEST_MISMATCH'
      ],
      [
        {
          files: [
            { length: 6, path: 'payload/first.bin' },
            { length: 10, path: 'payload/elsewhere.bin' }
          ]
        },
        'FILE_MANIFEST_MISMATCH'
      ],
      [
        {
          files: [
            { length: 6, path: 'payload/first.bin' },
            { length: 11, path: 'payload/nested/second.bin' }
          ]
        },
        'FILE_MANIFEST_MISMATCH'
      ]
    ]

    for (const [overrides, code] of cases) {
      expect(
        runMetadataCommitBarrier({
          expected: metadata,
          observed: observationFor(metadata, overrides),
          reservation
        })
      ).toMatchObject({ code, ok: false })
    }
  })

  it('refuses a noncanonical info dictionary', () => {
    // Keys deliberately out of byte order: WebTorrent, parse-torrent, and
    // ut_metadata may all re-encode, so only canonical bytes are acceptable.
    const noncanonical = Buffer.concat([
      Buffer.from('d4:infod4:name7:payload6:lengthi6e12:piece lengthi16384e'),
      Buffer.from('6:pieces20:'),
      Buffer.alloc(20),
      Buffer.from('ee')
    ])

    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata, {
          torrentFile: new Uint8Array(noncanonical)
        }),
        reservation
      })
    ).toMatchObject({ code: 'UNREADABLE_METADATA', ok: false })
  })

  it('refuses unreadable metadata before any comparison', () => {
    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata, {
          torrentFile: new Uint8Array([0x64, 0x65])
        }),
        reservation
      })
    ).toMatchObject({ code: 'UNREADABLE_METADATA', ok: false })
  })

  it('refuses to commit while the guarded store recorded a fault', () => {
    expect(
      runMetadataCommitBarrier({
        expected: metadata,
        observed: observationFor(metadata),
        reservation,
        storeFaults: [
          { code: 'GRANT_MISMATCH', detail: 'token' },
          { code: 'GEOMETRY_MISMATCH', detail: 'length' }
        ]
      })
    ).toEqual({ code: 'STORE_FAULTED', detail: 'GRANT_MISMATCH', ok: false })
  })
})
