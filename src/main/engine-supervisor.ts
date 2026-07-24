import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess } from 'electron'
import {
  engineChildMessageSchema,
  engineParentMessageSchema,
  engineStatusSchema,
  PROTOCOL_VERSION,
  type EngineChildMessage,
  type EngineParentMessage,
  type EngineStatus
} from '../shared/contracts'
import { checkPayloadBudget } from '../shared/payload-budget'
import type { Diagnostics } from './diagnostics'

const STARTUP_TIMEOUT_MS = 30_000
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 3_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const RESTART_DELAY_MS = 500
const STABLE_RESET_MS = 5 * 60_000
const ENGINE_MESSAGE_BUDGET = {
  maxBytes: 64 * 1024,
  maxDepth: 16,
  maxNodes: 1024
}

type RestartReason =
  'CRASHED' | 'FATAL_ERROR' | 'HEARTBEAT_TIMEOUT' | 'STARTUP_TIMEOUT'

type TerminationReason =
  | 'FATAL_ERROR'
  | 'HEARTBEAT_MESSAGE'
  | 'HEARTBEAT_TIMEOUT'
  | 'INITIALIZE_MESSAGE'
  | 'PROTOCOL_ERROR'
  | 'REPORTED_FAILURE'
  | 'SHUTDOWN'
  | 'SMOKE_TEST'
  | 'STARTUP_TIMEOUT'

type EngineSupervisorOptions = {
  appVersion: string
  diagnostics: Diagnostics
  entryPath: string
  getStateRevision: () => number
  onStatus: (status: EngineStatus) => void
  workingDirectory: string
}

export type EngineShutdownResult =
  | { outcome: 'not-running' }
  | { outcome: 'exited'; forced: boolean }
  | { outcome: 'timed-out'; killAccepted: boolean }

function engineEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
  }
  if (process.env.TMPDIR) environment.TMPDIR = process.env.TMPDIR
  return environment
}

export class EngineSupervisor {
  readonly #appVersion: string
  readonly #diagnostics: Diagnostics
  readonly #entryPath: string
  readonly #getStateRevision: () => number
  readonly #onStatus: (status: EngineStatus) => void
  readonly #workingDirectory: string
  #process: UtilityProcess | null = null
  #generationId: string | null = null
  #status: EngineStatus = {
    state: 'starting',
    generationId: null,
    restartCount: 0
  }
  #restartCount = 0
  #outboundSequence = 0
  #lastInboundSequence = -1
  #handshakeRequestId: string | null = null
  #pendingPingRequestId: string | null = null
  #stopping = false
  #restartReason: RestartReason = 'CRASHED'
  #startupTimer: NodeJS.Timeout | null = null
  #heartbeatTimer: NodeJS.Timeout | null = null
  #heartbeatTimeout: NodeJS.Timeout | null = null
  #restartTimer: NodeJS.Timeout | null = null
  #stableTimer: NodeJS.Timeout | null = null

  constructor(options: EngineSupervisorOptions) {
    this.#appVersion = options.appVersion
    this.#diagnostics = options.diagnostics
    this.#entryPath = options.entryPath
    this.#getStateRevision = options.getStateRevision
    this.#onStatus = options.onStatus
    this.#workingDirectory = options.workingDirectory
  }

  status(): EngineStatus {
    return structuredClone(this.#status)
  }

  processId(): number | null {
    return this.#process?.pid ?? null
  }

  start(): void {
    if (this.#process || this.#restartTimer) {
      throw new Error('Torrent engine supervisor is already running')
    }

    this.#stopping = false
    this.#spawn()
  }

  restart(): boolean {
    if (
      this.#status.state !== 'stopped' ||
      this.#process ||
      this.#restartTimer
    ) {
      return false
    }

    this.#restartCount = 0
    this.#restartReason = 'CRASHED'
    this.#stopping = false
    this.#spawn()
    return true
  }

  terminateForSmokeTest(): boolean {
    const child = this.#process
    if (!child || this.#status.state !== 'ready' || this.#stopping) {
      return false
    }

    this.#restartReason = 'CRASHED'
    this.#clearRunTimers()
    return this.#kill(child, 'SMOKE_TEST')
  }

  async stop(): Promise<EngineShutdownResult> {
    this.#stopping = true
    this.#clearTimers()

    const child = this.#process
    if (!child) return { outcome: 'not-running' }

    return new Promise<EngineShutdownResult>(resolve => {
      let settled = false
      let forced = false
      let timeout: NodeJS.Timeout | null = null
      let forcedExitTimer: NodeJS.Timeout | null = null
      const finish = (result: EngineShutdownResult): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (forcedExitTimer) clearTimeout(forcedExitTimer)
        child.off('exit', onExit)
        resolve(result)
      }
      const onExit = (): void => {
        finish({ outcome: 'exited', forced })
      }
      const forceShutdown = (): void => {
        if (settled || forced) return
        forced = true
        if (timeout) clearTimeout(timeout)
        this.#diagnostics.warn('engine.shutdown-forced')
        const killAccepted = this.#kill(child, 'SHUTDOWN')
        if (settled) return
        forcedExitTimer = setTimeout(() => {
          this.#diagnostics.error('engine.shutdown-exit-timeout')
          finish({ outcome: 'timed-out', killAccepted })
        }, SHUTDOWN_TIMEOUT_MS)
      }

      child.once('exit', onExit)
      timeout = setTimeout(forceShutdown, SHUTDOWN_TIMEOUT_MS)
      if (
        !this.#post(
          {
            type: 'engine:shutdown',
            requestId: randomUUID(),
            payload: { reason: 'APP_QUIT' }
          },
          child
        )
      ) {
        this.#diagnostics.error('engine.shutdown-message-failed')
        forceShutdown()
      }
    })
  }

  #spawn(): void {
    this.#restartTimer = null
    this.#generationId = randomUUID()
    this.#outboundSequence = 0
    this.#lastInboundSequence = -1
    this.#handshakeRequestId = randomUUID()
    this.#pendingPingRequestId = null
    this.#setStatus({
      state: 'starting',
      generationId: this.#generationId,
      restartCount: this.#restartCount
    })

    let child: UtilityProcess
    try {
      child = utilityProcess.fork(this.#entryPath, [], {
        cwd: this.#workingDirectory,
        env: engineEnvironment(),
        execArgv: [],
        serviceName: 'WebTorrent Updated Engine',
        stdio: 'ignore'
      })
    } catch {
      this.#generationId = null
      this.#setStatus({
        state: 'stopped',
        code: 'ENGINE_START_FAILED',
        message: 'Torrent engine could not be started.'
      })
      this.#diagnostics.error('engine.spawn-failed')
      return
    }
    this.#process = child

    child.on('spawn', () => {
      if (this.#process !== child) return
      this.#diagnostics.info('engine.spawned', {
        restartCount: this.#restartCount
      })
      if (
        !this.#post(
          {
            type: 'engine:initialize',
            requestId: this.#handshakeRequestId ?? randomUUID(),
            payload: {
              appVersion: this.#appVersion,
              stateRevision: this.#getStateRevision(),
              stateSchemaVersion: 1
            }
          },
          child
        )
      ) {
        this.#diagnostics.error('engine.initialize-message-failed')
        this.#restartReason = 'FATAL_ERROR'
        this.#clearRunTimers()
        this.#kill(child, 'INITIALIZE_MESSAGE')
        return
      }
      this.#startupTimer = setTimeout(() => {
        if (this.#process !== child) return
        this.#restartReason = 'STARTUP_TIMEOUT'
        this.#diagnostics.warn('engine.startup-timeout')
        this.#clearRunTimers()
        this.#kill(child, 'STARTUP_TIMEOUT')
      }, STARTUP_TIMEOUT_MS)
    })

    child.on('message', value => {
      this.#handleMessage(child, value)
    })

    child.on('error', (type, location) => {
      if (this.#process !== child) return
      this.#restartReason = 'FATAL_ERROR'
      this.#diagnostics.error('engine.fatal-error', {
        type,
        location
      })
      this.#clearRunTimers()
      this.#kill(child, 'FATAL_ERROR')
    })

    child.on('exit', code => {
      this.#handleExit(child, code)
    })
  }

  #handleMessage(child: UtilityProcess, value: unknown): void {
    if (this.#process !== child) {
      this.#diagnostics.warn('engine.stale-message')
      return
    }

    if (!checkPayloadBudget(value, ENGINE_MESSAGE_BUDGET).ok) {
      this.#diagnostics.warn('engine.message-over-budget')
      this.#failProtocol(child)
      return
    }

    const parsed = engineChildMessageSchema.safeParse(value)
    if (!parsed.success) {
      this.#diagnostics.warn('engine.invalid-message', {
        issueCount: parsed.error.issues.length
      })
      this.#failProtocol(child)
      return
    }

    const message = parsed.data
    if (
      message.generationId !== this.#generationId ||
      message.sequence <= this.#lastInboundSequence
    ) {
      this.#diagnostics.warn('engine.protocol-order')
      this.#failProtocol(child)
      return
    }
    this.#lastInboundSequence = message.sequence

    switch (message.type) {
      case 'engine:ready':
        this.#handleReady(child, message)
        break
      case 'engine:pong':
        if (message.requestId !== this.#pendingPingRequestId) {
          this.#failProtocol(child)
          return
        }
        this.#pendingPingRequestId = null
        if (this.#heartbeatTimeout) clearTimeout(this.#heartbeatTimeout)
        this.#heartbeatTimeout = null
        break
      case 'engine:stopped':
        break
      case 'engine:failed':
        this.#diagnostics.error('engine.reported-failure', {
          code: message.payload.code
        })
        this.#restartReason = 'CRASHED'
        this.#clearRunTimers()
        this.#kill(child, 'REPORTED_FAILURE')
        break
    }
  }

  #handleReady(
    child: UtilityProcess,
    message: Extract<EngineChildMessage, { type: 'engine:ready' }>
  ): void {
    if (
      message.requestId !== this.#handshakeRequestId ||
      this.#status.state !== 'starting'
    ) {
      this.#failProtocol(child)
      return
    }

    if (this.#startupTimer) clearTimeout(this.#startupTimer)
    this.#startupTimer = null
    this.#setStatus({
      state: 'ready',
      generationId: message.generationId,
      restartCount: this.#restartCount,
      ...message.payload
    })
    this.#diagnostics.info('engine.ready', {
      restartCount: this.#restartCount
    })
    this.#stableTimer = setTimeout(() => {
      if (
        this.#status.state === 'ready' &&
        this.#status.generationId === message.generationId
      ) {
        this.#restartCount = 0
        this.#setStatus({
          ...this.#status,
          restartCount: 0
        })
      }
    }, STABLE_RESET_MS)
    this.#heartbeatTimer = setInterval(() => {
      if (this.#process !== child) return
      const requestId = randomUUID()
      this.#pendingPingRequestId = requestId
      if (
        !this.#post(
          {
            type: 'engine:ping',
            requestId,
            payload: {}
          },
          child
        )
      ) {
        this.#pendingPingRequestId = null
        this.#restartReason = 'FATAL_ERROR'
        this.#diagnostics.error('engine.heartbeat-message-failed')
        this.#clearRunTimers()
        this.#kill(child, 'HEARTBEAT_MESSAGE')
        return
      }
      this.#heartbeatTimeout = setTimeout(() => {
        if (this.#pendingPingRequestId !== requestId) return
        this.#restartReason = 'HEARTBEAT_TIMEOUT'
        this.#diagnostics.warn('engine.heartbeat-timeout')
        this.#clearRunTimers()
        this.#kill(child, 'HEARTBEAT_TIMEOUT')
      }, HEARTBEAT_TIMEOUT_MS)
    }, HEARTBEAT_INTERVAL_MS)
  }

  #handleExit(child: UtilityProcess, code: number): void {
    if (this.#process !== child) return

    this.#process = null
    this.#clearRunTimers()
    this.#diagnostics.warn('engine.exited', {
      code,
      expected: this.#stopping,
      restartCount: this.#restartCount
    })
    if (this.#stopping) return

    if (this.#restartCount === 0) {
      this.#restartCount = 1
      this.#setStatus({
        state: 'restarting',
        generationId: this.#generationId ?? randomUUID(),
        restartCount: 1,
        reasonCode: this.#restartReason
      })
      this.#restartReason = 'CRASHED'
      this.#restartTimer = setTimeout(() => {
        this.#spawn()
      }, RESTART_DELAY_MS)
      return
    }

    this.#setStatus({
      state: 'stopped',
      code: 'ENGINE_CRASH_LOOP',
      message: 'Torrent engine stopped after repeated unexpected exits.'
    })
  }

  #failProtocol(child: UtilityProcess): void {
    this.#stopping = true
    this.#clearTimers()
    this.#kill(child, 'PROTOCOL_ERROR')
    this.#setStatus({
      state: 'stopped',
      code: 'ENGINE_PROTOCOL_ERROR',
      message: 'Torrent engine sent an invalid protocol message.'
    })
  }

  #post(
    partial:
      | Pick<
          Extract<EngineParentMessage, { type: 'engine:initialize' }>,
          'type' | 'requestId' | 'payload'
        >
      | Pick<
          Extract<EngineParentMessage, { type: 'engine:ping' }>,
          'type' | 'requestId' | 'payload'
        >
      | Pick<
          Extract<EngineParentMessage, { type: 'engine:shutdown' }>,
          'type' | 'requestId' | 'payload'
        >,
    child: UtilityProcess
  ): boolean {
    if (this.#process !== child || !this.#generationId) return false

    const message = engineParentMessageSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      generationId: this.#generationId,
      requestId: partial.requestId,
      sequence: this.#outboundSequence,
      timestampMs: Date.now(),
      type: partial.type,
      payload: partial.payload
    })
    if (!checkPayloadBudget(message, ENGINE_MESSAGE_BUDGET).ok) {
      throw new Error('Engine control message exceeds its fixed payload budget')
    }
    try {
      child.postMessage(message)
    } catch {
      return false
    }
    this.#outboundSequence += 1
    return true
  }

  #kill(child: UtilityProcess, reason: TerminationReason): boolean {
    if (this.#process !== child) return false

    let accepted: boolean
    try {
      accepted = child.kill()
    } catch {
      accepted = false
    }
    if (!accepted && this.#process === child) {
      this.#diagnostics.error('engine.kill-failed', { reason })
    }
    return accepted
  }

  #setStatus(status: EngineStatus): void {
    this.#status = engineStatusSchema.parse(status)
    this.#onStatus(structuredClone(this.#status))
  }

  #clearRunTimers(): void {
    if (this.#startupTimer) clearTimeout(this.#startupTimer)
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer)
    if (this.#heartbeatTimeout) clearTimeout(this.#heartbeatTimeout)
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#startupTimer = null
    this.#heartbeatTimer = null
    this.#heartbeatTimeout = null
    this.#stableTimer = null
    this.#pendingPingRequestId = null
  }

  #clearTimers(): void {
    this.#clearRunTimers()
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = null
  }
}
