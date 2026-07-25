import bencode from 'bencode'
import { describe, expect, it, vi } from 'vitest'
import {
  LocalTorrentReadError,
  type LocalTorrentReadOptions
} from './local-torrent-reader'
import {
  EgressPolicy,
  type RemoteTorrentFetchResult,
  type RemoteTorrentUrlOptions
} from './network-policy'
import { PreparationStore } from './preparation-store'
import type { PreparedMagnet } from './torrent-metadata'
import {
  canonicalInfoIdentity,
  validateTorrentMetadata
} from './torrent-metadata'
import {
  TorrentPreparationService,
  TorrentPreparationServiceError,
  type RemoteTorrentConsent,
  type TorrentPreparationServiceErrorCode,
  type TorrentPreparationSource
} from './torrent-preparation-service'

function singleFileTorrent(
  name: string,
  topLevel: Record<string, unknown> = {}
): Uint8Array {
  return bencode.encode({
    announce: 'https://tracker.example/announce',
    ...topLevel,
    info: {
      length: 1,
      name,
      'piece length': 16_384,
      pieces: new Uint8Array(20)
    }
  })
}

function local(path = '/authorized/example.torrent'): TorrentPreparationSource {
  return { kind: 'local-torrent', path }
}

function remote(
  url: string,
  consent: RemoteTorrentConsent = {
    allowHttp: false,
    allowPrivateNetwork: false
  }
): TorrentPreparationSource {
  return {
    ...consent,
    kind: 'remote-torrent',
    url
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

async function expectServiceError(
  operation: Promise<unknown>,
  code: TorrentPreparationServiceErrorCode
): Promise<TorrentPreparationServiceError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(TorrentPreparationServiceError)
    expect(error).toMatchObject({ code })
    return error as TorrentPreparationServiceError
  }
  throw new Error('Expected the preparation service operation to fail')
}

class StubRemotePolicy extends EgressPolicy {
  readonly #fetch: (
    value: string,
    options: RemoteTorrentUrlOptions
  ) => Promise<RemoteTorrentFetchResult>

  constructor(
    fetch: (
      value: string,
      options: RemoteTorrentUrlOptions
    ) => Promise<RemoteTorrentFetchResult>
  ) {
    super()
    this.#fetch = fetch
  }

  override async fetchRemoteTorrentBytes(
    value: string,
    options: RemoteTorrentUrlOptions
  ): Promise<RemoteTorrentFetchResult> {
    return await this.#fetch(value, options)
  }
}

describe('TorrentPreparationService', () => {
  it('opens local bytes without consulting remote policy and preserves warnings', async () => {
    const deadlineSignal = signal()
    const bytes = singleFileTorrent('local.txt', {
      'announce-list': [
        [
          'udp://tracker.example:6969/announce',
          'https://tracker.example/announce'
        ]
      ],
      'url-list': ['https://seed.example/content', 'file:///private/content']
    })
    const readLocalTorrent = vi.fn(
      async (
        _filePath: string,
        _options: LocalTorrentReadOptions
      ): Promise<Uint8Array> => bytes
    )
    const createRemotePolicy = vi.fn(() => {
      throw new Error('Remote policy must not be used for a local file')
    })
    const store = new PreparationStore()
    const service = new TorrentPreparationService({
      createRemotePolicy,
      readLocalTorrent,
      store
    })

    const result = await service.open(
      local('/authorized/private-name.torrent'),
      deadlineSignal
    )

    expect(readLocalTorrent).toHaveBeenCalledWith(
      '/authorized/private-name.torrent',
      { signal: deadlineSignal }
    )
    expect(createRemotePolicy).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      fileCount: 1,
      lifecycleState: 'open',
      name: 'local.txt',
      selectedFileCount: 0,
      sourcePolicy: { kind: 'local-torrent' },
      warnings: [
        'TRACKER_TRANSPORT_DISABLED',
        'WEB_SEED_INVALID',
        'WEB_SEED_DISABLED'
      ]
    })
    expect(JSON.stringify(result)).not.toContain('private-name')
    expect(store.get(result.preparationId)).toEqual(result)
  })

  it('retains a distinct policy for every exact remote consent tuple', async () => {
    const createdConsents: RemoteTorrentConsent[] = []
    const fetches: Array<
      Readonly<{
        allowHttp: boolean
        signal: AbortSignal | undefined
        url: string
      }>
    > = []
    const createRemotePolicy = vi.fn((consent: RemoteTorrentConsent) => {
      createdConsents.push({ ...consent })
      return new StubRemotePolicy(async (url, options) => {
        fetches.push({
          allowHttp: options.allowHttp,
          signal: options.signal,
          url
        })
        const name = new URL(url).pathname.slice(1)
        return { bytes: singleFileTorrent(name), finalUrl: url }
      })
    })
    const store = new PreparationStore()
    const service = new TorrentPreparationService({
      createRemotePolicy,
      store
    })
    const firstSignal = signal()
    const publicHttps = remote('https://source.example/public-one')
    const sameConsent = remote('https://source.example/public-two')
    const privateHttps = remote('https://source.example/private', {
      allowHttp: false,
      allowPrivateNetwork: true
    })
    const publicHttp = remote('http://source.example/http', {
      allowHttp: true,
      allowPrivateNetwork: false
    })
    const privateHttp = remote('http://source.example/private-http', {
      allowHttp: true,
      allowPrivateNetwork: true
    })

    const first = await service.open(publicHttps, firstSignal)
    store.discard(first.preparationId)
    const second = await service.open(sameConsent, signal())
    store.discard(second.preparationId)
    const third = await service.open(privateHttps, signal())
    const fourth = await service.open(publicHttp, signal())
    const fifth = await service.open(privateHttp, signal())

    expect(first.sourcePolicy).toEqual({
      allowHttp: false,
      allowPrivateNetwork: false,
      kind: 'remote-torrent'
    })
    expect(second.sourcePolicy).toEqual(first.sourcePolicy)
    expect(third.sourcePolicy).toEqual({
      allowHttp: false,
      allowPrivateNetwork: true,
      kind: 'remote-torrent'
    })
    expect(fourth.sourcePolicy).toEqual({
      allowHttp: true,
      allowPrivateNetwork: false,
      kind: 'remote-torrent'
    })
    expect(fifth.sourcePolicy).toEqual({
      allowHttp: true,
      allowPrivateNetwork: true,
      kind: 'remote-torrent'
    })
    expect(createdConsents).toEqual([
      { allowHttp: false, allowPrivateNetwork: false },
      { allowHttp: false, allowPrivateNetwork: true },
      { allowHttp: true, allowPrivateNetwork: false },
      { allowHttp: true, allowPrivateNetwork: true }
    ])
    expect(createRemotePolicy).toHaveBeenCalledTimes(4)
    expect(fetches[0]).toEqual({
      allowHttp: false,
      signal: firstSignal,
      url: 'https://source.example/public-one'
    })
  })

  it('enforces one aggregate two-fetch ceiling across consent policies', async () => {
    const pending = new Map<
      string,
      (result: RemoteTorrentFetchResult) => void
    >()
    const createRemotePolicy = (_consent: RemoteTorrentConsent): EgressPolicy =>
      new StubRemotePolicy(
        url =>
          new Promise(resolve => {
            pending.set(url, resolve)
          })
      )
    const service = new TorrentPreparationService({ createRemotePolicy })
    const firstUrl = 'https://source.example/first'
    const secondUrl = 'https://private.example/second'
    const first = service.open(remote(firstUrl), signal())
    const second = service.open(
      remote(secondUrl, {
        allowHttp: false,
        allowPrivateNetwork: true
      }),
      signal()
    )

    expect(pending.size).toBe(2)
    await expectServiceError(
      service.open(
        remote('http://source.example/third', {
          allowHttp: true,
          allowPrivateNetwork: false
        }),
        signal()
      ),
      'REMOTE_CONCURRENCY_LIMIT'
    )

    pending.get(firstUrl)?.({
      bytes: singleFileTorrent('first'),
      finalUrl: firstUrl
    })
    pending.get(secondUrl)?.({
      bytes: singleFileTorrent('second'),
      finalUrl: secondUrl
    })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('rejects a policy instance reused across different consent tuples', async () => {
    const policy = new StubRemotePolicy(async url => ({
      bytes: singleFileTorrent(new URL(url).pathname.slice(1)),
      finalUrl: url
    }))
    const service = new TorrentPreparationService({
      createRemotePolicy: () => policy
    })

    await service.open(remote('https://source.example/public'), signal())
    await expectServiceError(
      service.open(
        remote('https://source.example/private', {
          allowHttp: false,
          allowPrivateNetwork: true
        }),
        signal()
      ),
      'INTERNAL'
    )
  })

  it('acquires magnet metadata and reviews it like any other source', async () => {
    const readLocalTorrent = vi.fn()
    const bytes = singleFileTorrent('staged.txt')
    const acquired: Array<{ dhtEnabled: boolean; infoHash: string }> = []
    const acquireMetadata = vi.fn(async (prepared: PreparedMagnet) => {
      acquired.push({
        dhtEnabled: prepared.dhtEnabled,
        infoHash: prepared.infoHash
      })
      return bytes
    })
    const service = new TorrentPreparationService({
      acquireMetadata,
      readLocalTorrent
    })

    const infoHash = canonicalInfoIdentity(bytes).infoHash
    const snapshot = await service.open(
      {
        allowDhtExposure: false,
        allowPrivateNetwork: false,
        kind: 'magnet',
        magnet:
          `magnet:?xt=urn:btih:${infoHash}` +
          '&tr=https%3A%2F%2Ftracker.example%2Fannounce'
      },
      signal()
    )

    expect(snapshot.infoHash).toBe(infoHash)
    // Nothing reached the local reader, and the magnet's own consent was
    // carried into the acquisition.
    expect(readLocalTorrent).not.toHaveBeenCalled()
    expect(acquireMetadata).toHaveBeenCalledTimes(1)
    expect(acquired).toEqual([{ dhtEnabled: false, infoHash }])
  })

  it('reports an acquisition that never produced metadata', async () => {
    const service = new TorrentPreparationService({
      acquireMetadata: async () => {
        throw new Error('Metadata acquisition failed: TIMED_OUT.')
      },
      readLocalTorrent: vi.fn()
    })

    await expectServiceError(
      service.open(
        {
          allowDhtExposure: true,
          allowPrivateNetwork: false,
          infoHash: 'a'.repeat(40),
          kind: 'info-hash'
        },
        signal()
      ),
      'METADATA_UNAVAILABLE'
    )
  })

  it('returns fixed unsupported errors when no staging capability exists', async () => {
    const createRemotePolicy = vi.fn(() => new EgressPolicy())
    const readLocalTorrent = vi.fn()
    const service = new TorrentPreparationService({
      createRemotePolicy,
      readLocalTorrent
    })

    await expectServiceError(
      service.open(
        {
          allowDhtExposure: false,
          allowPrivateNetwork: false,
          kind: 'magnet',
          magnet: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        },
        signal()
      ),
      'UNSUPPORTED'
    )
    await expectServiceError(
      service.open(
        {
          allowDhtExposure: false,
          allowPrivateNetwork: false,
          infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          kind: 'info-hash'
        },
        signal()
      ),
      'UNSUPPORTED'
    )
    expect(createRemotePolicy).not.toHaveBeenCalled()
    expect(readLocalTorrent).not.toHaveBeenCalled()
  })

  it('propagates deadline aborts without retaining a preparation', async () => {
    const controller = new AbortController()
    const store = new PreparationStore()
    const readLocalTorrent = vi.fn(
      async (
        _filePath: string,
        options: LocalTorrentReadOptions
      ): Promise<Uint8Array> => {
        expect(options.signal).toBe(controller.signal)
        controller.abort()
        throw new LocalTorrentReadError('ABORTED')
      }
    )
    const service = new TorrentPreparationService({
      readLocalTorrent,
      store
    })

    await expectServiceError(
      service.open(local(), controller.signal),
      'ABORTED'
    )
    expect(store.size).toBe(0)
  })

  it('does not retain metadata when cancellation wins during validation', async () => {
    const controller = new AbortController()
    const store = new PreparationStore()
    const service = new TorrentPreparationService({
      readLocalTorrent: async () => singleFileTorrent('cancelled.txt'),
      store,
      validateMetadata: async (bytes, policy) => {
        const metadata = await validateTorrentMetadata(bytes, policy)
        controller.abort()
        return metadata
      }
    })

    await expectServiceError(
      service.open(local(), controller.signal),
      'ABORTED'
    )
    expect(store.size).toBe(0)
  })

  it('maps phase failures to fixed errors without leaking paths or URLs', async () => {
    const secretPath = '/private/secret/noah/example.torrent'
    const localService = new TorrentPreparationService({
      readLocalTorrent: async () => {
        throw new Error(`Could not open ${secretPath}`)
      }
    })
    const localError = await expectServiceError(
      localService.open(local(secretPath), signal()),
      'LOCAL_TORRENT_UNAVAILABLE'
    )
    expect(localError.message).not.toContain(secretPath)

    const secretUrl = 'https://user-private.example/secret.torrent'
    const remoteService = new TorrentPreparationService({
      createRemotePolicy: () =>
        new StubRemotePolicy(async () => {
          throw new Error(`Could not fetch ${secretUrl}`)
        })
    })
    const remoteError = await expectServiceError(
      remoteService.open(remote(secretUrl), signal()),
      'REMOTE_TORRENT_UNAVAILABLE'
    )
    expect(remoteError.message).not.toContain(secretUrl)

    const invalidService = new TorrentPreparationService({
      readLocalTorrent: async () => new Uint8Array([1, 2, 3])
    })
    await expectServiceError(
      invalidService.open(local(), signal()),
      'INPUT_INVALID'
    )
  })

  it('maps duplicate preparations without exposing store internals', async () => {
    const bytes = singleFileTorrent('duplicate')
    const service = new TorrentPreparationService({
      readLocalTorrent: async () => bytes
    })

    await service.open(local(), signal())
    const error = await expectServiceError(
      service.open(local('/authorized/second.torrent'), signal()),
      'ALREADY_EXISTS'
    )
    expect(error.message).toBe('Torrent preparation failed: ALREADY_EXISTS.')
  })
})
