import type { EngineCommand } from '../shared/engine-api'
import {
  LocalTorrentReadError,
  readLocalTorrentFile
} from './local-torrent-reader'
import { EgressPolicy, type RemoteTorrentFetchResult } from './network-policy'
import {
  PreparationStore,
  PreparationStoreError,
  type PreparationSnapshot,
  type PreparationSourcePolicy,
  type PreparationWarning
} from './preparation-store'
import {
  TorrentInputError,
  type ValidatedTorrentMetadata,
  validateTorrentMetadata
} from './torrent-metadata'

const MAX_CONCURRENT_REMOTE_FETCHES = 2

type OpenPreparationCommand = Extract<
  EngineCommand,
  { command: 'open-preparation' }
>

export type TorrentPreparationSource =
  OpenPreparationCommand['payload']['source']

type RemoteTorrentSource = Extract<
  TorrentPreparationSource,
  { kind: 'remote-torrent' }
>

export type RemoteTorrentConsent = Readonly<{
  allowHttp: boolean
  allowPrivateNetwork: boolean
}>

export type TorrentPreparationServiceErrorCode =
  | 'ABORTED'
  | 'ALREADY_EXISTS'
  | 'CAPACITY_EXCEEDED'
  | 'INPUT_INVALID'
  | 'INTERNAL'
  | 'LOCAL_TORRENT_UNAVAILABLE'
  | 'REMOTE_CONCURRENCY_LIMIT'
  | 'REMOTE_TORRENT_UNAVAILABLE'
  | 'UNSUPPORTED'

export class TorrentPreparationServiceError extends Error {
  readonly code: TorrentPreparationServiceErrorCode

  constructor(code: TorrentPreparationServiceErrorCode) {
    super(`Torrent preparation failed: ${code}.`)
    this.name = 'TorrentPreparationServiceError'
    this.code = code
  }
}

type LocalTorrentReader = (
  filePath: string,
  options: Readonly<{ signal?: AbortSignal }>
) => Promise<Uint8Array>

type MetadataValidator = (
  input: Uint8Array,
  policy: EgressPolicy
) => Promise<ValidatedTorrentMetadata>

type RemotePolicyFactory = (consent: RemoteTorrentConsent) => EgressPolicy

export type TorrentPreparationServiceOptions = Readonly<{
  createRemotePolicy?: RemotePolicyFactory
  localMetadataPolicy?: EgressPolicy
  readLocalTorrent?: LocalTorrentReader
  store?: PreparationStore
  validateMetadata?: MetadataValidator
}>

function consentKey(consent: RemoteTorrentConsent): string {
  return `${consent.allowHttp ? 'http' : 'https'}:${
    consent.allowPrivateNetwork ? 'private' : 'public'
  }`
}

function sourcePolicy(
  source: Extract<
    TorrentPreparationSource,
    { kind: 'local-torrent' | 'remote-torrent' }
  >
): PreparationSourcePolicy {
  if (source.kind === 'local-torrent') return { kind: 'local-torrent' }
  return {
    allowHttp: source.allowHttp,
    allowPrivateNetwork: source.allowPrivateNetwork,
    kind: 'remote-torrent'
  }
}

function additionalWarnings(
  metadata: ValidatedTorrentMetadata
): ReadonlyArray<PreparationWarning> {
  return metadata.webSeeds.length > 0 ? ['WEB_SEED_DISABLED'] : []
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TorrentPreparationServiceError('ABORTED')
  }
}

function localReadFailure(
  error: unknown,
  signal: AbortSignal
): TorrentPreparationServiceError {
  if (
    signal.aborted ||
    (error instanceof LocalTorrentReadError && error.code === 'ABORTED')
  ) {
    return new TorrentPreparationServiceError('ABORTED')
  }
  if (
    error instanceof LocalTorrentReadError &&
    (error.code === 'FILE_TOO_LARGE' || error.code === 'NOT_REGULAR_FILE')
  ) {
    return new TorrentPreparationServiceError('INPUT_INVALID')
  }
  return new TorrentPreparationServiceError('LOCAL_TORRENT_UNAVAILABLE')
}

function storeFailure(error: unknown): TorrentPreparationServiceError {
  if (error instanceof PreparationStoreError) {
    if (error.code === 'DUPLICATE_INFO_HASH') {
      return new TorrentPreparationServiceError('ALREADY_EXISTS')
    }
    if (error.code === 'CAPACITY_EXCEEDED') {
      return new TorrentPreparationServiceError('CAPACITY_EXCEEDED')
    }
  }
  return new TorrentPreparationServiceError('INTERNAL')
}

export class TorrentPreparationService {
  readonly #createRemotePolicy: RemotePolicyFactory
  readonly #localMetadataPolicy: EgressPolicy
  readonly #readLocalTorrent: LocalTorrentReader
  readonly #remotePolicies = new Map<string, EgressPolicy>()
  readonly #store: PreparationStore
  readonly #validateMetadata: MetadataValidator
  #activeRemoteFetches = 0

  constructor(options: TorrentPreparationServiceOptions = {}) {
    this.#createRemotePolicy =
      options.createRemotePolicy ??
      (consent =>
        new EgressPolicy({
          allowPrivateNetwork: consent.allowPrivateNetwork
        }))
    this.#localMetadataPolicy =
      options.localMetadataPolicy ?? new EgressPolicy()
    this.#readLocalTorrent = options.readLocalTorrent ?? readLocalTorrentFile
    this.#store = options.store ?? new PreparationStore()
    this.#validateMetadata = options.validateMetadata ?? validateTorrentMetadata
  }

  async open(
    source: TorrentPreparationSource,
    signal: AbortSignal
  ): Promise<PreparationSnapshot> {
    throwIfAborted(signal)
    switch (source.kind) {
      case 'local-torrent':
        return await this.#openLocal(source, signal)
      case 'remote-torrent':
        return await this.#openRemote(source, signal)
      case 'info-hash':
      case 'magnet':
        throw new TorrentPreparationServiceError('UNSUPPORTED')
    }
  }

  async #openLocal(
    source: Extract<TorrentPreparationSource, { kind: 'local-torrent' }>,
    signal: AbortSignal
  ): Promise<PreparationSnapshot> {
    let bytes: Uint8Array
    try {
      bytes = await this.#readLocalTorrent(source.path, { signal })
    } catch (error) {
      throw localReadFailure(error, signal)
    }

    return await this.#validateAndStore(
      bytes,
      this.#localMetadataPolicy,
      sourcePolicy(source),
      signal
    )
  }

  async #openRemote(
    source: RemoteTorrentSource,
    signal: AbortSignal
  ): Promise<PreparationSnapshot> {
    throwIfAborted(signal)
    const url = source.url
    const consent = {
      allowHttp: source.allowHttp,
      allowPrivateNetwork: source.allowPrivateNetwork
    } as const
    const policySnapshot = sourcePolicy(source)
    const policy = this.#policyFor(consent)
    let fetched: RemoteTorrentFetchResult

    if (this.#activeRemoteFetches >= MAX_CONCURRENT_REMOTE_FETCHES) {
      throw new TorrentPreparationServiceError('REMOTE_CONCURRENCY_LIMIT')
    }
    this.#activeRemoteFetches += 1
    try {
      fetched = await policy.fetchRemoteTorrentBytes(url, {
        allowHttp: consent.allowHttp,
        signal
      })
    } catch {
      throw new TorrentPreparationServiceError(
        signal.aborted ? 'ABORTED' : 'REMOTE_TORRENT_UNAVAILABLE'
      )
    } finally {
      this.#activeRemoteFetches -= 1
    }

    return await this.#validateAndStore(
      fetched.bytes,
      policy,
      policySnapshot,
      signal
    )
  }

  #policyFor(consent: RemoteTorrentConsent): EgressPolicy {
    const key = consentKey(consent)
    const retained = this.#remotePolicies.get(key)
    if (retained) return retained

    let created: EgressPolicy
    try {
      created = this.#createRemotePolicy(consent)
    } catch {
      throw new TorrentPreparationServiceError('INTERNAL')
    }
    if ([...this.#remotePolicies.values()].some(policy => policy === created)) {
      throw new TorrentPreparationServiceError('INTERNAL')
    }
    this.#remotePolicies.set(key, created)
    return created
  }

  async #validateAndStore(
    bytes: Uint8Array,
    policy: EgressPolicy,
    policySnapshot: PreparationSourcePolicy,
    signal: AbortSignal
  ): Promise<PreparationSnapshot> {
    throwIfAborted(signal)
    let metadata: ValidatedTorrentMetadata
    try {
      metadata = await this.#validateMetadata(bytes, policy)
    } catch (error) {
      if (signal.aborted) {
        throw new TorrentPreparationServiceError('ABORTED')
      }
      throw new TorrentPreparationServiceError(
        error instanceof TorrentInputError ? 'INPUT_INVALID' : 'INTERNAL'
      )
    }
    throwIfAborted(signal)

    try {
      return this.#store.create({
        metadata,
        sourcePolicy: policySnapshot,
        warnings: additionalWarnings(metadata)
      })
    } catch (error) {
      throw storeFailure(error)
    }
  }
}
