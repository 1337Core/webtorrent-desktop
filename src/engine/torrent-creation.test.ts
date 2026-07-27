import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bencode from 'bencode'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreateTorrentOptions } from 'create-torrent'
import { EgressPolicy } from './network-policy'
import {
  TorrentCreationError,
  TorrentCreationService,
  type TorrentCreationRequest
} from './torrent-creation'

let root = ''
let sourcePath = ''

function torrentBytes(
  options: { announceList?: string[][]; private?: boolean } = {}
): Uint8Array {
  return bencode.encode({
    announce: options.announceList?.[0]?.[0] ?? 'https://tracker.example/x',
    'announce-list': options.announceList ?? [['https://tracker.example/x']],
    info: {
      length: 4,
      name: 'payload.bin',
      'piece length': 16_384,
      pieces: new Uint8Array(20),
      ...(options.private ? { private: 1 } : {})
    }
  })
}

function createService(
  overrides: {
    create?: (
      input: string | string[] | Uint8Array,
      options: CreateTorrentOptions,
      callback: (error: Error | null, torrent?: Uint8Array) => void
    ) => void
  } = {}
): { calls: CreateTorrentOptions[]; service: TorrentCreationService } {
  const calls: CreateTorrentOptions[] = []
  const service = new TorrentCreationService({
    create:
      overrides.create ??
      ((_input, options, callback) => {
        calls.push(options)
        callback(
          null,
          torrentBytes({
            ...(options.announceList
              ? { announceList: options.announceList }
              : {}),
            private: options.private === true
          })
        )
      }),
    policy: new EgressPolicy()
  })
  return { calls, service }
}

function request(
  overrides: Partial<TorrentCreationRequest> = {}
): TorrentCreationRequest {
  return {
    allowHttpTrackers: false,
    announceTiers: [['https://tracker.example/x']],
    filterJunkFiles: true,
    private: false,
    sourcePath,
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wu-create-'))
  sourcePath = path.join(root, 'payload.bin')
  await writeFile(sourcePath, 'data')
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
  vi.restoreAllMocks()
})

describe('TorrentCreationService', () => {
  it('creates validated bytes and seeds from the source parent', async () => {
    const { calls, service } = createService()

    const result = await service.create(request({ comment: 'notes' }))

    expect(result.seedRoot).toBe(root)
    expect(result.metadata).toMatchObject({
      announceTiers: [['https://tracker.example/x']],
      name: 'payload.bin',
      private: false
    })
    expect(calls[0]).toMatchObject({
      announceList: [['https://tracker.example/x']],
      comment: 'notes',
      createdBy: 'WebTorrent Updated',
      filterJunkFiles: true,
      private: false
    })
  })

  it('rejects a tracker the engine cannot mediate', async () => {
    const { service } = createService()

    await expect(
      service.create(
        request({ announceTiers: [['udp://tracker.example:6969/announce']] })
      )
    ).rejects.toMatchObject({ code: 'TRACKER_REJECTED' })
    await expect(
      service.create(
        request({ announceTiers: [['ws://tracker.example/announce']] })
      )
    ).rejects.toMatchObject({ code: 'TRACKER_REJECTED' })
  })

  it('requires explicit consent for a cleartext HTTP tracker', async () => {
    const { service } = createService()

    await expect(
      service.create(
        request({ announceTiers: [['http://tracker.example/announce']] })
      )
    ).rejects.toMatchObject({ code: 'TRACKER_REJECTED' })

    const allowed = await service.create(
      request({
        allowHttpTrackers: true,
        announceTiers: [['http://tracker.example/announce']]
      })
    )
    expect(allowed.metadata.announceTiers).toEqual([
      ['http://tracker.example/announce']
    ])
  })

  it('requires at least one tracker for a private torrent', async () => {
    const { service } = createService()

    await expect(
      service.create(request({ announceTiers: [], private: true }))
    ).rejects.toMatchObject({ code: 'PRIVATE_TRACKER_REQUIRED' })

    const created = await service.create(request({ private: true }))
    expect(created.metadata.private).toBe(true)
  })

  it('refuses a relative, denormalized, or symlinked source', async () => {
    const { service } = createService()

    await expect(
      service.create(request({ sourcePath: 'payload.bin' }))
    ).rejects.toBeInstanceOf(TorrentCreationError)
    await expect(
      service.create(request({ sourcePath: `${root}/./payload.bin` }))
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })

    const linked = path.join(root, 'link.bin')
    await symlink(sourcePath, linked)
    await expect(
      service.create(request({ sourcePath: linked }))
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' })

    await expect(
      service.create(request({ sourcePath: path.join(root, 'absent.bin') }))
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_AUTHORIZED' })
  })

  it('rejects unusable names and oversized comments', async () => {
    const { service } = createService()

    await expect(
      service.create(request({ name: 'nested/name' }))
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    await expect(service.create(request({ name: '' }))).rejects.toMatchObject({
      code: 'INPUT_INVALID'
    })
    await expect(
      service.create(request({ comment: 'x'.repeat(4_097) }))
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
  })

  it('reports a failing or unusable creation as one fixed error', async () => {
    const failing = createService({
      create: (_input, _options, callback) => {
        callback(new Error('hashing failed'))
      }
    })
    await expect(failing.service.create(request())).rejects.toMatchObject({
      code: 'CREATION_FAILED'
    })

    const unusable = createService({
      create: (_input, _options, callback) => {
        callback(null, new Uint8Array([0x64, 0x65]))
      }
    })
    await expect(unusable.service.create(request())).rejects.toMatchObject({
      code: 'CREATION_FAILED'
    })
  })

  it('refuses bytes whose privacy bit does not match the request', async () => {
    const mismatched = createService({
      create: (_input, _options, callback) => {
        callback(null, torrentBytes({ private: false }))
      }
    })

    await expect(
      mismatched.service.create(request({ private: true }))
    ).rejects.toMatchObject({ code: 'CREATION_FAILED' })
  })
})
