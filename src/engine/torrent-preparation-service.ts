import type { EngineCommand } from '../shared/engine-api'
import {
  LocalTorrentReadError,
  readLocalTorrentFile
} from './local-torrent-reader'
import { EgressPolicy, type RemoteTorrentFetchResult } from './network-policy'
import {
  PREPARATION_LIMITS,
  PreparationStore,
  PreparationStoreError,
  type PreparationSnapshot,
  type PreparationSourcePolicy,
  type PreparationWarning
} from './preparation-store'
import {
  prepareMagnet,
  TorrentInputError,
  type PreparedMagnet,
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
  | 'DHT_CONSENT_REQUIRED'
  | 'INPUT_INVALID'
  | 'INTERNAL'
  | 'LOCAL_TORRENT_UNAVAILABLE'
  | 'METADATA_UNAVAILABLE'
  | 'PRIVATE_DHT_METADATA'
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
  /**
   * Acquires metadata for a magnet or info hash. Without one the engine has
   * no staging capability and both flows stay unsupported rather than
   * silently reaching the network by some other route.
   */
  acquireMetadata?: MetadataAcquirer
  createRemotePolicy?: RemotePolicyFactory
  localMetadataPolicy?: EgressPolicy
  readLocalTorrent?: LocalTorrentReader
  store?: PreparationStore
  validateMetadata?: MetadataValidator
}>

export type MetadataAcquirer = (
  prepared: PreparedMagnet,
  signal: AbortSignal
) => Promise<Uint8Array>

function consentKey(consent: RemoteTorrentConsent): string {
  return `${consent.allowHttp ? 'http' : 'https'}:${
    consent.allowPrivateNetwork ? 'private' : 'public'
  }`
}

function sourcePolicy(
  source: TorrentPreparationSource
): PreparationSourcePolicy {
  if (source.kind === 'local-torrent') return { kind: 'local-torrent' }
  if (source.kind === 'remote-torrent') {
    return {
      allowHttp: source.allowHttp,
      allowPrivateNetwork: source.allowPrivateNetwork,
      kind: 'remote-torrent'
    }
  }
  // The consent a staged acquisition ran under is recorded with it.
  return {
    allowDhtExposure: source.allowDhtExposure,
    allowPrivateNetwork: source.allowPrivateNetwork,
    kind: source.kind
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
    if (error.code === 'INVALID_SELECTION') {
      return new TorrentPreparationServiceError('INPUT_INVALID')
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
  readonly #acquireMetadata: MetadataAcquirer | null
  readonly #validateMetadata: MetadataValidator
  #activeRemoteFetches = 0

  constructor(options: TorrentPreparationServiceOptions = {}) {
    this.#acquireMetadata = options.acquireMetadata ?? null
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
        return await this.#openStaged(source, signal)
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

  /**
   * A magnet or info hash carries no metadata, so the engine must acquire it
   * before anything can be reviewed. The magnet is parsed and its consent
   * settled first; only then is a staging acquisition allowed to run, and its
   * bytes go through exactly the same validation as a local file.
   */
  async #openStaged(
    source: Extract<
      TorrentPreparationSource,
      { kind: 'info-hash' } | { kind: 'magnet' }
    >,
    signal: AbortSignal
  ): Promise<PreparationSnapshot> {
    const acquire = this.#acquireMetadata
    if (!acquire) throw new TorrentPreparationServiceError('UNSUPPORTED')
    throwIfAborted(signal)

    const policy = this.#policyFor({
      allowHttp: false,
      allowPrivateNetwork: source.allowPrivateNetwork
    })
    let prepared: PreparedMagnet
    try {
      prepared = await prepareMagnet(
        source.kind === 'magnet' ? source.magnet : source.infoHash,
        policy,
        { allowDht: source.allowDhtExposure }
      )
    } catch (error) {
      throw new TorrentPreparationServiceError(
        error instanceof TorrentInputError &&
          error.code === 'DHT_CONSENT_REQUIRED'
          ? 'DHT_CONSENT_REQUIRED'
          : 'INPUT_INVALID'
      )
    }

    let bytes: Uint8Array
    try {
      bytes = await acquire(prepared, signal)
    } catch (error) {
      throwIfAborted(signal)
      throw new TorrentPreparationServiceError(
        error instanceof Error && error.message.includes('CAPACITY')
          ? 'CAPACITY_EXCEEDED'
          : 'METADATA_UNAVAILABLE'
      )
    }

    return await this.#validateAndStore(
      bytes,
      policy,
      sourcePolicy(source),
      signal,
      {
        dhtExposureUsed: prepared.dhtEnabled,
        selection: prepared.selection,
        warnings: prepared.warnings,
        xsRemoved: prepared.xsRemoved
      }
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
    signal: AbortSignal,
    staged: Readonly<{
      dhtExposureUsed: boolean
      selection: ReadonlyArray<number>
      warnings: ReadonlyArray<PreparationWarning>
      xsRemoved: boolean
    }> | null = null
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

    if (staged?.dhtExposureUsed && metadata.private) {
      throw new TorrentPreparationServiceError('PRIVATE_DHT_METADATA')
    }

    let createdPreparationId: string | null = null
    try {
      let snapshot = this.#store.create({
        metadata,
        sourcePolicy: policySnapshot,
        warnings: [
          ...additionalWarnings(metadata),
          ...(staged?.warnings ?? []),
          ...(staged?.dhtExposureUsed ? (['DHT_EXPOSURE_USED'] as const) : []),
          ...(staged?.xsRemoved ? (['XS_REMOVED'] as const) : [])
        ]
      })
      createdPreparationId = snapshot.preparationId
      if (staged && staged.selection.length > 0) {
        for (
          let offset = 0;
          offset < staged.selection.length;
          offset += PREPARATION_LIMITS.selectionChanges
        ) {
          snapshot = this.#store.updateSelection(
            snapshot.preparationId,
            staged.selection
              .slice(offset, offset + PREPARATION_LIMITS.selectionChanges)
              .map(index => ({ index, selected: true }))
          )
        }
      }
      return snapshot
    } catch (error) {
      if (createdPreparationId) {
        try {
          this.#store.discard(createdPreparationId)
        } catch {
          // The failed preparation is already gone.
        }
      }
      throw storeFailure(error)
    }
  }
}
