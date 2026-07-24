import { describe, expect, it } from 'vitest'
import {
  engineCommandResultSchema,
  engineCommandSchema,
  engineEventSchema,
  torrentSummarySchema
} from './engine-api'

const preparationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const leaseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const infoHash = '0123456789abcdef0123456789abcdef01234567'

const torrentSummary = {
  infoHash,
  name: 'Example',
  length: 1,
  fileCount: 1,
  selectedFileCount: 1,
  private: false,
  state: 'downloading',
  progress: 0.5,
  downloaded: 1,
  uploaded: 0,
  downloadSpeed: 1,
  uploadSpeed: 0,
  peerCount: 1,
  timeRemainingMs: 1_000
} as const

describe('engine command contracts', () => {
  it('accepts bounded prepare, lifecycle, create, and media commands', () => {
    const commands = [
      {
        command: 'open-preparation',
        payload: {
          source: {
            kind: 'magnet',
            magnet: `magnet:?xt=urn:btih:${infoHash}`,
            allowDhtExposure: false,
            allowPrivateNetwork: false
          }
        }
      },
      {
        command: 'open-preparation',
        payload: {
          source: {
            kind: 'info-hash',
            infoHash,
            allowDhtExposure: true,
            allowPrivateNetwork: false
          }
        }
      },
      {
        command: 'get-preparation-files',
        payload: { preparationId, cursor: 0, limit: 64 }
      },
      {
        command: 'update-preparation-selection',
        payload: {
          preparationId,
          changes: [{ index: 0, selected: true }]
        }
      },
      {
        command: 'commit-preparation',
        payload: { preparationId, destinationRoot: '/tmp/downloads' }
      },
      {
        command: 'discard-preparation',
        payload: { preparationId }
      },
      {
        command: 'list-torrents',
        payload: { cursor: 0, limit: 64 }
      },
      {
        command: 'get-torrent-files',
        payload: { infoHash, cursor: 0, limit: 64 }
      },
      { command: 'pause-torrent', payload: { infoHash } },
      { command: 'resume-torrent', payload: { infoHash } },
      {
        command: 'remove-torrent',
        payload: { infoHash, deleteData: false }
      },
      {
        command: 'create-torrent',
        payload: {
          operationId,
          sourcePath: '/tmp/source',
          destinationRoot: '/tmp/downloads',
          private: false,
          announceTiers: [],
          allowHttpTrackers: false,
          allowPrivateNetwork: false,
          filterJunkFiles: true
        }
      },
      { command: 'open-media', payload: { infoHash, fileIndex: 0 } },
      { command: 'heartbeat-media', payload: { leaseId } },
      { command: 'close-media', payload: { leaseId } }
    ]

    for (const command of commands) {
      expect(
        engineCommandSchema.safeParse(command).success,
        command.command
      ).toBe(true)
    }
  })

  it('rejects duplicate selection indexes and destructive removal', () => {
    expect(
      engineCommandSchema.safeParse({
        command: 'update-preparation-selection',
        payload: {
          preparationId,
          changes: [
            { index: 1, selected: true },
            { index: 1, selected: false }
          ]
        }
      }).success
    ).toBe(false)
    expect(
      engineCommandSchema.safeParse({
        command: 'remove-torrent',
        payload: { infoHash, deleteData: true }
      }).success
    ).toBe(false)
  })

  it('requires trackers for private creation and consent for HTTP trackers', () => {
    const base = {
      command: 'create-torrent',
      payload: {
        operationId,
        sourcePath: '/tmp/source',
        destinationRoot: '/tmp/downloads',
        private: true,
        announceTiers: [],
        allowHttpTrackers: false,
        allowPrivateNetwork: false,
        filterJunkFiles: true
      }
    } as const

    expect(engineCommandSchema.safeParse(base).success).toBe(false)
    expect(
      engineCommandSchema.safeParse({
        ...base,
        payload: {
          ...base.payload,
          announceTiers: [['http://tracker.example/announce']]
        }
      }).success
    ).toBe(false)
    expect(
      engineCommandSchema.safeParse({
        ...base,
        payload: {
          ...base.payload,
          announceTiers: [['http://tracker.example/announce']],
          allowHttpTrackers: true
        }
      }).success
    ).toBe(true)
  })

  it('rejects relative authorized paths and oversized magnet bytes', () => {
    for (const destinationRoot of [
      '../escape',
      '/',
      '/tmp//downloads',
      '/tmp/downloads/'
    ]) {
      expect(
        engineCommandSchema.safeParse({
          command: 'commit-preparation',
          payload: { preparationId, destinationRoot }
        }).success
      ).toBe(false)
    }
    expect(
      engineCommandSchema.safeParse({
        command: 'open-preparation',
        payload: {
          source: {
            kind: 'magnet',
            magnet: `magnet:?dn=${'é'.repeat(33_000)}`,
            allowDhtExposure: false,
            allowPrivateNetwork: false
          }
        }
      }).success
    ).toBe(false)
  })

  it('binds insecure remote fetches to consent and rejects URL secrets', () => {
    const remote = (url: string, allowHttp: boolean) => ({
      command: 'open-preparation',
      payload: {
        source: {
          kind: 'remote-torrent',
          url,
          allowHttp,
          allowPrivateNetwork: false
        }
      }
    })

    expect(
      engineCommandSchema.safeParse(
        remote('http://example.test/a.torrent', false)
      ).success
    ).toBe(false)
    expect(
      engineCommandSchema.safeParse(
        remote('http://example.test/a.torrent', true)
      ).success
    ).toBe(true)
    expect(
      engineCommandSchema.safeParse(
        remote('https://user:secret@example.test/a.torrent', true)
      ).success
    ).toBe(false)
    expect(
      engineCommandSchema.safeParse(
        remote('https://example.test/a.torrent#secret', true)
      ).success
    ).toBe(false)
  })
})

describe('engine result and event contracts', () => {
  it('accepts compact torrent summaries and paginated results', () => {
    expect(torrentSummarySchema.safeParse(torrentSummary).success).toBe(true)
    expect(
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'list-torrents',
          value: {
            items: [torrentSummary],
            nextCursor: null,
            total: 1
          }
        }
      }).success
    ).toBe(true)
    expect(
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'list-torrents',
          value: {
            items: [torrentSummary],
            nextCursor: null,
            total: 0
          }
        }
      }).success
    ).toBe(false)
  })

  it('rejects unsafe result paths and invalid loopback media ports', () => {
    expect(
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'get-torrent-files',
          value: {
            infoHash,
            items: [
              {
                index: 0,
                path: '../escape',
                length: 1,
                selected: true,
                downloaded: 0,
                progress: 0
              }
            ],
            nextCursor: null,
            total: 1
          }
        }
      }).success
    ).toBe(false)
    expect(() =>
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'open-media',
          value: {
            infoHash,
            fileIndex: 0,
            leaseId,
            url: `http://127.0.0.1:99999/v1/media/${'a'.repeat(43)}`,
            expiresAtMs: 1
          }
        }
      })
    ).not.toThrow()
    expect(
      engineCommandResultSchema.safeParse({
        ok: true,
        result: {
          command: 'open-media',
          value: {
            infoHash,
            fileIndex: 0,
            leaseId,
            url: `http://127.0.0.1:99999/v1/media/${'a'.repeat(43)}`,
            expiresAtMs: 1
          }
        }
      }).success
    ).toBe(false)
  })

  it('accepts fixed errors without raw exception details', () => {
    expect(
      engineCommandResultSchema.safeParse({
        ok: false,
        error: {
          command: 'open-preparation',
          code: 'INPUT_INVALID',
          displayMessage: 'The torrent input is invalid.',
          retryable: false
        }
      }).success
    ).toBe(true)
    expect(
      engineCommandResultSchema.safeParse({
        ok: false,
        error: {
          command: 'open-preparation',
          code: 'INPUT_INVALID',
          displayMessage: 'The torrent input is invalid.',
          retryable: false,
          stack: 'not allowed'
        }
      }).success
    ).toBe(false)
  })

  it('accepts bounded progress and revocation events', () => {
    expect(
      engineEventSchema.safeParse({
        event: 'creation-progress',
        payload: {
          operationId,
          hashedBytes: 5,
          totalBytes: 10
        }
      }).success
    ).toBe(true)
    expect(
      engineEventSchema.safeParse({
        event: 'media-revoked',
        payload: {
          leaseId,
          reason: 'PAUSED'
        }
      }).success
    ).toBe(true)
    expect(
      engineEventSchema.safeParse({
        event: 'creation-progress',
        payload: {
          operationId,
          hashedBytes: 11,
          totalBytes: 10
        }
      }).success
    ).toBe(false)
  })
})
