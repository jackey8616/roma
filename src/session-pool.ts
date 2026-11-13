import { EventEmitter } from 'node:events'
import { CAVEMAN_OFF, cavemanRuleset } from './caveman.js'
import {
  spawnRuntimeProcess,
  type RuntimeProcess,
  type SeatOutcome,
  type SpawnRuntimeProcess,
} from './runtime-process.js'
import {
  ClaudeExitedError,
  ClaudeSession,
  NO_CONVERSATION,
  PINNED_EFFORT,
  PINNED_MODEL,
  TERMINATE_GRACE_MS,
  TranscriptNotFound,
  type Turn,
  type UnsolicitedTurn,
} from './claude-session.js'
import type { CredentialKind } from './build-env.js'
import { defaultConfig, type RetryBudget } from './config.js'
import { realLauncher, type SessionLauncher } from './launcher.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { readApiRetry, type ApiRetry, type ClaudeEvent } from './stream-events.js'
import { POOL_SEATS, Seats } from './seats.js'
import type { WorkRoot } from './work-root.js'

const MAX_RESIDENT = 10
const IDLE_REAP_MS = 15 * 60_000
const RECLAIM_INTERVAL_MS = 60 * 60_000
const ALREADY_IN_USE = /session id .* is already in use/i

export type PoolLogRecord =
  | {
      readonly event: 'spawn'
      readonly sessionId: string
      readonly resume: boolean
      readonly cwd: string
      readonly credential: CredentialKind
      readonly model: string
      readonly effort: string
      readonly caveman: string
      readonly residents: number
    }
  | {
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'credential'
      readonly from: CredentialKind
      readonly to: CredentialKind
    }
  | {
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'model' | 'effort' | 'caveman'
      readonly from: string
      readonly to: string
    }
  | {
      readonly event: 'evict' | 'reap'
      readonly sessionId: string
      readonly idleMs: number
      readonly residents: number
    }
  | {
      readonly event: 'exit'
      readonly sessionId: string
      readonly code: number | null
      readonly signal: string | null
    }
  | { readonly event: 'kill'; readonly sessionId: string; readonly graceMs: number }
  | {
      readonly event: 'retry-storm'
      readonly sessionId: string
      readonly retries: number
      readonly elapsedMs: number
      readonly limit: 'retries' | 'window'
      readonly status: number | null
      readonly error: string | null
    }
  | {
      readonly event: 'resume-lost' | 'transcript-survived'
      readonly sessionId: string
      readonly refusal: string
      readonly retryWith: '--resume' | '--session-id'
    }
  | {
      readonly event: 'reclaim'
      readonly sessionId: string
      readonly cwd: string
      readonly idleMs: number
    }
  | {
      readonly event: 'reclaim-failed'
      readonly sessionId: string
      readonly reason: string
    }
  | {
      readonly event: 'quarantine'
      readonly seat: number
      readonly sessionId: string
      readonly reason: string
    }
  | { readonly event: 'reap-deferred'; readonly sessionId: string }
  | {
      readonly event: 'result-late'
      readonly sessionId: string
      readonly resultIndex: number | null
      readonly isError: boolean
    }
  | {
      readonly event: 'result-undelivered'
      readonly sessionId: string
      readonly resultIndex: number | null
      readonly origin: string | null
      readonly reason: string
    }

interface Correction {
  readonly event: 'resume-lost' | 'transcript-survived'
  readonly resume: boolean
  readonly reason: string
}

export type PoolLog = OperatorLog<PoolLogRecord>

export const logToStderr: PoolLog = writeToStderr

export class RetryStormError extends Error {
  readonly retries: number
  readonly elapsedMs: number
  readonly lastRetry: ApiRetry

  constructor(retries: number, elapsedMs: number, lastRetry: ApiRetry) {
    super(
      `Turn abandoned after ${retries} API retries over ${elapsedMs}ms ` +
        `(status=${lastRetry.errorStatus ?? 'null'}, error=${lastRetry.error ?? 'null'})`,
    )
    this.name = 'RetryStormError'
    this.retries = retries
    this.elapsedMs = elapsedMs
    this.lastRetry = lastRetry
  }
}

export type BuildSessionEnv = (sessionId: string, seat: number) => Readonly<Record<string, string>>

export type CredentialEnvs = Readonly<Partial<Record<CredentialKind, BuildSessionEnv>>>

export interface SessionModels {
  readonly kind: 'model'
  inForce(sessionId: string): string
}

export interface SessionEfforts {
  readonly kind: 'effort'
  inForce(sessionId: string): string
}

export interface SessionCavemen {
  readonly kind: 'caveman'
  inForce(sessionId: string): string
}

export interface SpawnTerms {
  readonly credential: CredentialKind
  readonly model: string
  readonly effort: string
  readonly caveman: string
  readonly appendSystemPrompt: string | undefined
}

export interface SessionPoolOptions {
  readonly workRoot: WorkRoot
  readonly envs: CredentialEnvs
  readonly model?: string
  readonly models?: SessionModels
  readonly effort?: string
  readonly efforts?: SessionEfforts
  readonly caveman?: string
  readonly cavemen?: SessionCavemen
  readonly announcements?: readonly string[]
  readonly maxResident?: number
  readonly seats?: readonly number[]
  readonly launcher?: SessionLauncher
  readonly reclaimIntervalMs?: number
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnRuntimeProcess
  readonly log?: PoolLog
}

export interface SessionPoolEvents {
  event: [sessionId: string, event: ClaudeEvent]
  'turn-start': [sessionId: string, text: string, uuid: string]
  'turn-end': [sessionId: string, turn: Turn]
  unsolicited: [sessionId: string, turn: UnsolicitedTurn]
}

interface RetryWatch {
  count: number
  readonly startedAt: number
  timer: NodeJS.Timeout | null
  last: ApiRetry
}

interface Resident {
  readonly sessionId: string
  readonly seat: number
  readonly cwd: string
  readonly credential: CredentialKind
  readonly model: string
  readonly effort: string
  readonly caveman: string
  readonly appendSystemPrompt: string | undefined
  started: Promise<boolean>
  readonly session: ClaudeSession
  readonly resumed: boolean
  stderr: string
  busy: boolean
  lastUsedAt: number
  reapTimer: NodeJS.Timeout | null
  leaving: boolean
  retry: RetryWatch | null
  storm: RetryStormError | null
}

export class SessionPool extends EventEmitter<SessionPoolEvents> {
  readonly #workRoot: WorkRoot
  readonly #envs: CredentialEnvs
  readonly #model: string | undefined
  readonly #models: SessionModels | undefined
  readonly #effort: string | undefined
  readonly #efforts: SessionEfforts | undefined
  readonly #caveman: string | undefined
  readonly #cavemen: SessionCavemen | undefined
  readonly #announcements: readonly string[]
  readonly #maxResident: number
  readonly #retryBudget: RetryBudget
  readonly #spawnProcess: SpawnRuntimeProcess
  readonly #seats: Seats
  readonly #launcher: SessionLauncher
  readonly #log: PoolLog

  readonly #residents = new Map<string, Resident>()
  readonly #leases = new Map<number, string>()
  readonly #leaseIds = new Map<number, object>()
  #spawning: Promise<unknown> = Promise.resolve()
  readonly #reclaimTimer: NodeJS.Timeout

  constructor(options: SessionPoolOptions) {
    super()
    this.#workRoot = options.workRoot
    this.#envs = options.envs
    this.#model = options.model
    this.#models = options.models
    this.#effort = options.effort
    this.#efforts = options.efforts
    this.#caveman = options.caveman
    this.#cavemen = options.cavemen
    this.#announcements = options.announcements ?? []
    this.#maxResident = options.maxResident ?? MAX_RESIDENT
    this.#seats = new Seats(options.seats ?? POOL_SEATS)
    if (this.#maxResident > this.#seats.size) {
      throw new Error(
        `maxResident is ${this.#maxResident} but there are ${this.#seats.size} Seats to lease: ` +
          'every Resident Session holds a Seat of its own (ADR-0036).',
      )
    }
    this.#launcher = options.launcher ?? realLauncher()
    this.#retryBudget = options.retryBudget ?? defaultConfig.retryBudget
    this.#spawnProcess = options.spawn ?? spawnRuntimeProcess
    this.#log = options.log ?? logToStderr

    this.#reclaimTimer = setInterval(
      () => void this.reclaimIdleWorkDirs(),
      options.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS,
    )
    this.#reclaimTimer.unref?.()
  }

  get residents(): string[] {
    return [...this.#residents.keys()]
  }

  async send(
    sessionId: string,
    text: string,
    credential: CredentialKind = 'shared-window',
  ): Promise<Turn> {
    return await this.#turn(await this.#acquire(sessionId, credential), text)
  }

  sessionOn(seat: number): string | null {
    return this.#leases.get(seat) ?? null
  }

  leaseOn(seat: number): object | null {
    return this.#leaseIds.get(seat) ?? null
  }

  cavemanOn(sessionId: string): string | null {
    return this.#residents.get(sessionId)?.caveman ?? null
  }

  interrupt(sessionId: string): boolean {
    return this.#residents.get(sessionId)?.session.interrupt() ?? false
  }

  async evict(sessionId: string): Promise<boolean> {
    const resident = this.#residents.get(sessionId)
    if (resident === undefined) return false
    await this.#retire(resident, 'evict')
    return true
  }

  async enclose(
    sessionId: string,
    credential: CredentialKind,
    name: string,
    content: Uint8Array,
  ): Promise<void> {
    const resident = await this.#acquire(sessionId, credential)
    if (!(await resident.started)) {
      throw new Error(
        `Session ${sessionId}'s Seat ${resident.seat} never started, so its Enclosure ` +
          `${name} has nowhere to go`,
      )
    }
    await this.#launcher.enclose(resident.seat, sessionId, name, content)
  }

  async reclaimIdleWorkDirs(): Promise<string[]> {
    let reclaimed: readonly { sessionId: string; cwd: string; idleMs: number }[]
    try {
      reclaimed = await this.#workRoot.reclaimIdle(new Set(this.#residents.keys()))
    } catch (error) {
      this.#log({
        event: 'reclaim-failed',
        sessionId: '',
        reason: error instanceof Error ? error.message : String(error),
      })
      return []
    }
    for (const { sessionId, cwd, idleMs } of reclaimed) {
      this.#log({ event: 'reclaim', sessionId, cwd, idleMs })
    }
    return reclaimed.map(({ sessionId }) => sessionId)
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#reclaimTimer)
    const residents = [...this.#residents.values()]
    this.#residents.clear()
    await Promise.all(
      residents.map(async (resident) => {
        this.#cancelReap(resident)
        await this.#terminate(resident)
      }),
    )
  }

  async #turn(resident: Resident, text: string, corrected = false): Promise<Turn> {
    resident.busy = true
    this.#cancelReap(resident)
    try {
      return await resident.session.send(text)
    } catch (error) {
      if (resident.storm !== null) throw resident.storm
      if (corrected) throw error
      const correction = this.#wrongFlag(resident, error)
      if (correction === null) throw error
      this.#log({
        event: correction.event,
        sessionId: resident.sessionId,
        refusal: refusalOf(resident.stderr, correction.reason),
        retryWith: correction.resume ? '--resume' : '--session-id',
      })
      this.#leave(resident)
      await this.#terminate(resident)
      return await this.#turn(
        await this.#spawn(resident.sessionId, resident, correction.resume),
        text,
        true,
      )
    } finally {
      resident.busy = false
      this.#clearRetryWatch(resident)
      this.#markUsed(resident)
      this.#workRoot.touch(resident.sessionId)
      if (this.#residents.get(resident.sessionId) === resident) this.#scheduleReap(resident)
    }
  }

  async #acquire(sessionId: string, credential: CredentialKind): Promise<Resident> {
    const caveman = this.#cavemanFor(sessionId)
    const terms: SpawnTerms = {
      credential,
      model: this.#modelFor(sessionId),
      effort: this.#effortFor(sessionId),
      caveman,
      appendSystemPrompt: this.#appendSystemPromptFor(caveman),
    }
    const resident = this.#residents.get(sessionId)
    if (resident !== undefined && resident.session.alive) {
      if (sameTerms(resident, terms)) {
        this.#markUsed(resident)
        return resident
      }
      await this.#swap(resident, terms)
    } else if (resident !== undefined) {
      this.#forget(resident)
    }
    return await this.#spawn(sessionId, terms)
  }

  #modelFor(sessionId: string): string {
    return this.#models?.inForce(sessionId) ?? this.#model ?? PINNED_MODEL
  }

  #effortFor(sessionId: string): string {
    return this.#efforts?.inForce(sessionId) ?? this.#effort ?? PINNED_EFFORT
  }

  #cavemanFor(sessionId: string): string {
    return this.#cavemen?.inForce(sessionId) ?? this.#caveman ?? CAVEMAN_OFF
  }

  #appendSystemPromptFor(caveman: string): string | undefined {
    const said = [...this.#announcements, cavemanRuleset(caveman)]
      .filter((part) => part !== '')
      .join('\n\n')
    return said === '' ? undefined : said
  }

  async #spawn(sessionId: string, terms: SpawnTerms, resume?: boolean): Promise<Resident> {
    const spawned = this.#spawning.then(() => this.#spawnNow(sessionId, terms, resume))
    this.#spawning = spawned.catch(() => undefined)
    return await spawned
  }

  async #spawnNow(
    sessionId: string,
    { credential, model, effort, caveman, appendSystemPrompt }: SpawnTerms,
    resume?: boolean,
  ): Promise<Resident> {
    const buildEnvFor = this.#envs[credential]
    if (buildEnvFor === undefined) {
      throw new Error(`no environment is configured for the ${credential} credential`)
    }
    await this.#makeRoom()
    const seat = await this.#seats.lease()
    this.#leases.set(seat, sessionId)
    this.#leaseIds.set(seat, {})

    const cwd = this.#workRoot.sessionDir(sessionId)
    const resuming = resume ?? this.#workRoot.hasSpawned(sessionId)
    this.#workRoot.markSpawned(sessionId)
    this.#workRoot.touch(sessionId)

    const session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnvFor(sessionId, seat),
      resume: resuming,
      spawn: (request) => {
        const process = this.#seated(
          this.#spawnProcess({ ...request, seat: { seat, sessionId } }),
          seat,
          sessionId,
        )
        resident.started = process.started
        return process
      },
      model,
      effort,
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    })
    const resident: Resident = {
      sessionId,
      seat,
      cwd,
      credential,
      model,
      effort,
      caveman,
      appendSystemPrompt,
      session,
      started: Promise.resolve(false),
      resumed: resuming,
      stderr: '',
      busy: false,
      lastUsedAt: Date.now(),
      reapTimer: null,
      leaving: false,
      retry: null,
      storm: null,
    }

    session.on('event', (event) => {
      this.emit('event', sessionId, event)
      const retry = readApiRetry(event)
      if (retry !== null) this.#onRetry(resident, retry)
    })
    session.on('turn-start', (text, uuid) => this.emit('turn-start', sessionId, text, uuid))
    session.on('turn-end', (turn) => this.emit('turn-end', sessionId, turn))
    session.on('late', (late) => this.#log({ event: 'result-late', sessionId, ...late }))
    session.on('unsolicited', (turn) => {
      if (this.emit('unsolicited', sessionId, turn)) return
      this.#log({
        event: 'result-undelivered',
        sessionId,
        resultIndex: turn.resultIndex,
        origin: turn.origin,
        reason: 'no-listener',
      })
    })
    session.on('stderr', (chunk) => {
      resident.stderr += chunk
    })
    session.on('exit', (exit) => {
      this.#cancelReap(resident)
      this.#clearRetryWatch(resident)
      this.#forget(resident)
      if (resident.leaving) return
      this.#log({ event: 'exit', sessionId, code: exit.code, signal: exit.signal })
    })

    this.#residents.set(sessionId, resident)
    session.start()
    this.#log({
      event: 'spawn',
      sessionId,
      resume: resuming,
      cwd,
      credential,
      model,
      effort,
      caveman,
      residents: this.#residents.size,
    })
    this.#scheduleReap(resident)
    return resident
  }

  #seated(process: RuntimeProcess, seat: number, sessionId: string): RuntimeProcess {
    let settled = false
    const settle = (outcome: SeatOutcome | undefined): void => {
      if (settled) return
      settled = true
      if (this.#leases.get(seat) === sessionId) {
        this.#leases.delete(seat)
        this.#leaseIds.delete(seat)
      }
      if (outcome === undefined || outcome.returned) {
        this.#seats.give(seat)
        return
      }
      this.#seats.quarantine(seat)
      this.#log({ event: 'quarantine', seat, sessionId, reason: outcome.reason })
    }
    process.onExit((exit) => settle(exit.seat))
    process.onError(() => settle(undefined))
    return process
  }

  async #makeRoom(): Promise<void> {
    while (
      this.#residents.size > 0 &&
      this.#residents.size >= Math.min(this.#maxResident, this.#seats.size)
    ) {
      const victim = [...this.#residents.values()].find(
        (resident) => !resident.busy && !resident.session.backgroundBusy,
      )
      if (victim === undefined) {
        throw new Error(`every one of the ${this.#residents.size} resident Sessions is busy`)
      }
      await this.#retire(victim, 'evict')
    }
  }

  async #retire(resident: Resident, event: 'evict' | 'reap'): Promise<void> {
    this.#leave(resident)
    this.#log({
      event,
      sessionId: resident.sessionId,
      idleMs: Date.now() - resident.lastUsedAt,
      residents: this.#residents.size,
    })
    await this.#terminate(resident)
  }

  async #swap(
    resident: Resident,
    { credential, model, effort, caveman }: SpawnTerms,
  ): Promise<void> {
    this.#leave(resident)
    const sessionId = resident.sessionId
    this.#log(
      resident.model !== model
        ? { event: 'swap', sessionId, reason: 'model', from: resident.model, to: model }
        : resident.effort !== effort
          ? { event: 'swap', sessionId, reason: 'effort', from: resident.effort, to: effort }
          : resident.caveman !== caveman
            ? { event: 'swap', sessionId, reason: 'caveman', from: resident.caveman, to: caveman }
            : {
                event: 'swap',
                sessionId,
                reason: 'credential',
                from: resident.credential,
                to: credential,
              },
    )
    await this.#terminate(resident)
  }

  #leave(resident: Resident): void {
    this.#cancelReap(resident)
    this.#forget(resident)
  }

  async #terminate(resident: Resident): Promise<void> {
    if (!resident.session.alive) return
    resident.leaving = true
    await resident.session.terminateOrKill(TERMINATE_GRACE_MS, () =>
      this.#log({ event: 'kill', sessionId: resident.sessionId, graceMs: TERMINATE_GRACE_MS }),
    )
  }

  #onRetry(resident: Resident, retry: ApiRetry): void {
    if (!resident.busy || resident.storm !== null) return

    let watch = resident.retry
    if (watch === null) {
      watch = { count: 1, startedAt: Date.now(), timer: null, last: retry }
      watch.timer = setTimeout(() => this.#abandon(resident, 'window'), this.#retryBudget.windowMs)
      watch.timer.unref?.()
      resident.retry = watch
    } else {
      watch.count += 1
      watch.last = retry
    }

    if (watch.count < this.#retryBudget.maxApiRetries) return
    this.#abandon(resident, 'retries')
  }

  #abandon(resident: Resident, limit: 'retries' | 'window'): void {
    const watch = resident.retry
    if (watch === null || resident.storm !== null) return

    const elapsedMs = Date.now() - watch.startedAt
    resident.storm = new RetryStormError(watch.count, elapsedMs, watch.last)
    this.#clearRetryWatch(resident)
    this.#cancelReap(resident)
    this.#forget(resident)
    this.#log({
      event: 'retry-storm',
      sessionId: resident.sessionId,
      retries: watch.count,
      elapsedMs,
      limit,
      status: watch.last.errorStatus,
      error: watch.last.error,
    })
    void this.#terminate(resident).catch(() => {})
  }

  #clearRetryWatch(resident: Resident): void {
    if (resident.retry?.timer != null) clearTimeout(resident.retry.timer)
    resident.retry = null
  }

  #scheduleReap(resident: Resident): void {
    this.#cancelReap(resident)
    const timer = setTimeout(() => {
      if (resident.session.backgroundBusy) {
        this.#log({ event: 'reap-deferred', sessionId: resident.sessionId })
        this.#scheduleReap(resident)
        return
      }
      void this.#retire(resident, 'reap').catch(() => {})
    }, IDLE_REAP_MS)
    timer.unref?.()
    resident.reapTimer = timer
  }

  #cancelReap(resident: Resident): void {
    if (resident.reapTimer === null) return
    clearTimeout(resident.reapTimer)
    resident.reapTimer = null
  }

  #markUsed(resident: Resident): void {
    if (this.#residents.get(resident.sessionId) === resident) {
      this.#residents.delete(resident.sessionId)
      this.#residents.set(resident.sessionId, resident)
    }
    resident.lastUsedAt = Date.now()
  }

  #forget(resident: Resident): void {
    if (this.#residents.get(resident.sessionId) === resident) {
      this.#residents.delete(resident.sessionId)
    }
  }

  #wrongFlag(resident: Resident, error: unknown): Correction | null {
    if (error instanceof TranscriptNotFound) {
      return resident.resumed ? { event: 'resume-lost', resume: false, reason: error.reason } : null
    }
    if (!(error instanceof ClaudeExitedError)) return null
    if (resident.resumed) {
      return NO_CONVERSATION.test(resident.stderr)
        ? { event: 'resume-lost', resume: false, reason: resident.stderr }
        : null
    }
    return ALREADY_IN_USE.test(resident.stderr)
      ? { event: 'transcript-survived', resume: true, reason: resident.stderr }
      : null
  }
}

const COMPARED: { readonly [Term in keyof SpawnTerms]: boolean } = {
  credential: true,
  model: true,
  effort: true,
  caveman: false,
  appendSystemPrompt: true,
}

function sameTerms(resident: Resident, terms: SpawnTerms): boolean {
  return (Object.keys(COMPARED) as (keyof SpawnTerms)[]).every(
    (term) => !COMPARED[term] || resident[term] === terms[term],
  )
}

function refusalOf(stderr: string, reason: string): string {
  if (stderr.includes(reason)) return stderr
  if (stderr === '') return reason
  return `${stderr.trimEnd()}\n${reason}`
}
