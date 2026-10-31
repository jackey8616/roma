import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CAVEMAN_OFF, cavemanRuleset } from './caveman.js'
import { spawnClaudeProcess, type SpawnClaudeProcess } from './claude-process.js'
import {
  ClaudeExitedError,
  ClaudeSession,
  NO_CONVERSATION,
  PINNED_EFFORT,
  PINNED_MODEL,
  TERMINATE_GRACE_MS,
  TranscriptNotFound,
  type Turn,
} from './claude-session.js'
import type { CredentialKind } from './build-env.js'
import { defaultConfig, type RetryBudget } from './config.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { readApiRetry, type ApiRetry, type ClaudeEvent } from './stream-events.js'
import type { WorkRoot } from './work-root.js'

const MAX_RESIDENT = 10
const IDLE_REAP_MS = 15 * 60_000
const RECLAIM_INTERVAL_MS = 60 * 60_000
/** Enforced by `fence:pool-spawned-before-is-a-file`. */
const SPAWN_FILE = '.roma-session'
/**
 * What `claude --session-id` says when a transcript for that id already exists.
 * Measured, not assumed — `docs/transcript-collision-verification.md` Q2 and Q3
 * run it at a reclaimed working directory and get "Error: Session ID … is
 * already in use." on Claude Code v2.1.220 (`#wrongFlag` is where it is read).
 */
const ALREADY_IN_USE = /session id .* is already in use/i

/**
 * A Turn that took an extra cold start is explained by a `spawn` with
 * `resume: true`, and nowhere else.
 */
export type PoolLogRecord =
  | {
      readonly event: 'spawn'
      readonly sessionId: string
      readonly resume: boolean
      readonly cwd: string
      readonly credential: CredentialKind
      /** This Session's Chosen Model, or the Pinned Model. */
      readonly model: string
      /** This Session's Chosen Effort, or the Pinned Effort. */
      readonly effort: string
      /** This Session's Chosen Caveman, or the Pinned Caveman: the level, never the ruleset. */
      readonly caveman: string
      readonly residents: number
    }
  | {
      /**
       * A process ended because the next Turn's terms are not the ones it was
       * started for.
       *
       * One record per swap however many terms moved. It names the model if that
       * moved, else the effort, else the Caveman, else the credential; every term
       * is on the `spawn` record that follows.
       */
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'credential'
      readonly from: CredentialKind
      readonly to: CredentialKind
    }
  | {
      /** The same event, moving between models, efforts or Cavemen rather than between bills. */
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
      /** A Turn abandoned mid-retry. */
      readonly event: 'retry-storm'
      readonly sessionId: string
      readonly retries: number
      readonly elapsedMs: number
      /** Which of the two budgets ran out first. */
      readonly limit: 'retries' | 'window'
      readonly status: number | null
      readonly error: string | null
    }
  | {
      /**
       * A spawn that guessed wrong about whether the Session already exists,
       * recovered by retrying once with the other flag: `resume-lost` reached for
       * a transcript that is not there, `transcript-survived` created one that is.
       */
      readonly event: 'resume-lost' | 'transcript-survived'
      readonly sessionId: string
      /**
       * How the CLI refused, in its own words: its stderr and the Turn's ending,
       * each once, whichever arrived. Never empty. Enforced by
       * `fence:refusal-keeps-both-halves`.
       */
      readonly refusal: string
      readonly retryWith: '--resume' | '--session-id'
    }
  | {
      readonly event: 'reclaim'
      readonly sessionId: string
      readonly cwd: string
      readonly idleMs: number
    }

/** Enforced by `fence:pool-refusal-reason-is-carried`. */
interface Correction {
  readonly event: 'resume-lost' | 'transcript-survived'
  readonly resume: boolean
  /** Whatever said so, in Claude Code's words. */
  readonly reason: string
}

export type PoolLog = OperatorLog<PoolLogRecord>

/** The default log: one JSON object per line on stderr. */
export const logToStderr: PoolLog = writeToStderr

/**
 * A Turn abandoned because it was retrying more than the budget allows: roma
 * deciding, where a `ClaudeExitedError` is a process dying.
 */
export class RetryStormError extends Error {
  readonly retries: number
  /** Measured from the Turn's first retry, not from its start. */
  readonly elapsedMs: number
  /**
   * The last retry seen: the only account of the underlying failure, because the
   * error proper surfaces only once the retries are exhausted.
   */
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

/**
 * One Session's environment, built by `buildEnv`. Cheap: everything expensive or
 * secret is closed over once at startup, and only the Session id a Credential
 * Shim reports a request under is filled in here.
 */
export type BuildSessionEnv = (sessionId: string) => Readonly<Record<string, string>>

/**
 * The environment to spawn with for each credential a Turn can be paid for by.
 * A deployment with no metered key has no Overflow entry, and a Turn that asks
 * for one is refused rather than served on the subscription.
 */
export type CredentialEnvs = Readonly<Partial<Record<CredentialKind, BuildSessionEnv>>>

/** Which model a Session runs on, asked afresh at every spawn. */
export interface SessionModels {
  /** Enforced by `fence:pool-ports-are-distinct`. */
  readonly kind: 'model'
  inForce(sessionId: string): string
}

/** What effort a Session runs at, asked afresh at every spawn. */
export interface SessionEfforts {
  /** Enforced by `fence:pool-ports-are-distinct`. */
  readonly kind: 'effort'
  inForce(sessionId: string): string
}

/**
 * How short a Session is asked to be, asked afresh at every spawn. Answers a
 * level and never the text; `cavemanRuleset` renders it.
 */
export interface SessionCavemen {
  /** Enforced by `fence:pool-ports-are-distinct`. */
  readonly kind: 'caveman'
  inForce(sessionId: string): string
}

/**
 * What a process is started for, and therefore what its Turns run on. Fixed at
 * spawn: a Turn on other terms gets a new process.
 *
 * `caveman` and `appendSystemPrompt` are one fact, the level and the text
 * rendered from it, read together. Enforced by `fence:pool-caveman-read-once`.
 */
export interface SpawnTerms {
  readonly credential: CredentialKind
  readonly model: string
  readonly effort: string
  /** The Caveman level `appendSystemPrompt` below was rendered from. */
  readonly caveman: string
  /**
   * Absent where there is nothing to append, and never empty for it. Enforced by
   * `fence:pool-empty-append-is-absent`.
   */
  readonly appendSystemPrompt: string | undefined
}

export interface SessionPoolOptions {
  readonly workRoot: WorkRoot
  readonly envs: CredentialEnvs
  /**
   * The model every Session runs on, for a pool built without `models`. Only
   * tests omit `models`; `startup.ts` always supplies it.
   */
  readonly model?: string
  /** Which model each Session runs on. Omitted, every Session runs on `model`. */
  readonly models?: SessionModels
  /**
   * What effort every Session runs at, for a pool built without `efforts`. Only
   * tests omit `efforts`.
   */
  readonly effort?: string
  /** What effort each Session runs at. Omitted, every Session runs at `effort`. */
  readonly efforts?: SessionEfforts
  /**
   * How short every Session is asked to be, for a pool built without `cavemen`.
   * Only tests omit `cavemen`.
   */
  readonly caveman?: string
  /** How short each Session is asked to be. Omitted, every Session is asked for `caveman`. */
  readonly cavemen?: SessionCavemen
  /**
   * What every Session is told about what roma can reach, one part per Reach,
   * each exactly what that Reach announces. Pass the empty string an unavailable
   * Reach announces as it is; the pool drops empty parts and appends the Caveman
   * ruleset after the rest.
   */
  readonly announcements?: readonly string[]
  readonly maxResident?: number
  readonly reclaimIntervalMs?: number
  /** How much retrying a Turn may do before it is abandoned. */
  readonly retryBudget?: RetryBudget
  readonly spawn?: SpawnClaudeProcess
  readonly log?: PoolLog
}

export interface SessionPoolEvents {
  event: [sessionId: string, event: ClaudeEvent]
  'turn-start': [sessionId: string, text: string]
  'turn-end': [sessionId: string, turn: Turn]
}

/**
 * What the running Turn has spent of its retry budget.
 *
 * Its presence is the fact that this Turn has started retrying at all, which is
 * why it is one nullable object rather than counters that have to be reset in
 * step with each other.
 */
interface RetryWatch {
  count: number
  readonly startedAt: number
  timer: NodeJS.Timeout | null
  last: ApiRetry
}

interface Resident {
  readonly sessionId: string
  readonly cwd: string
  readonly credential: CredentialKind
  readonly model: string
  readonly effort: string
  readonly caveman: string
  readonly appendSystemPrompt: string | undefined
  readonly session: ClaudeSession
  readonly resumed: boolean
  stderr: string
  busy: boolean
  lastUsedAt: number
  reapTimer: NodeJS.Timeout | null
  leaving: boolean
  /** Null until the running Turn's first retry, and again once it ends. */
  retry: RetryWatch | null
  /** Set when this Turn was abandoned, so its process's death is explained. */
  storm: RetryStormError | null
}

/**
 * Callers send a message to a Session id and get back a Turn; whether a running
 * process served it, or one resumed or created for it, shows only in the log
 * and in how long the Turn took.
 */
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
  readonly #spawnProcess: SpawnClaudeProcess
  readonly #log: PoolLog

  /** Insertion-ordered, so the first entry is the least recently used. */
  readonly #residents = new Map<string, Resident>()
  /** Enforced by `fence:pool-spawns-one-at-a-time`. */
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
    this.#retryBudget = options.retryBudget ?? defaultConfig.retryBudget
    this.#spawnProcess = options.spawn ?? spawnClaudeProcess
    this.#log = options.log ?? logToStderr

    this.#reclaimTimer = setInterval(
      () => this.reclaimIdleWorkDirs(),
      options.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS,
    )
    this.#reclaimTimer.unref?.()
  }

  /** Resident Session ids, least recently used first. */
  get residents(): string[] {
    return [...this.#residents.keys()]
  }

  /**
   * Send one message to a Session and wait for the Turn it drives. The Session
   * is pinned against eviction until the Turn ends.
   * Enforced by `fence:pool-busy-session-is-never-evicted`.
   *
   * Does not serialise: two concurrent messages to one Session is a caller bug,
   * and the Task Queue is what prevents it. Rejects with `RetryStormError` if the
   * Turn spends its retry budget.
   */
  async send(
    sessionId: string,
    text: string,
    credential: CredentialKind = 'shared-window',
  ): Promise<Turn> {
    return await this.#turn(await this.#acquire(sessionId, credential), text)
  }

  /**
   * How short the process serving this Session was asked to be: the process's
   * own level, never a fresh reading of the record. Enforced by
   * `fence:pool-caveman-is-what-the-process-ran-at`.
   *
   * Null where no process serves it, such as a Task stopped in the queue or a
   * process that died with its Turn in flight. What to record then is the
   * caller's to decide.
   */
  cavemanOn(sessionId: string): string | null {
    return this.#residents.get(sessionId)?.caveman ?? null
  }

  /**
   * Ask a resident Session to abandon its running Turn. Its process survives.
   * False if there was no Turn to abandon, including when the Session is not
   * resident.
   */
  interrupt(sessionId: string): boolean {
    return this.#residents.get(sessionId)?.session.interrupt() ?? false
  }

  /** End a Session's process now. It resumes with its context on the next message. */
  async evict(sessionId: string): Promise<boolean> {
    const resident = this.#residents.get(sessionId)
    if (resident === undefined) return false
    await this.#retire(resident, 'evict')
    return true
  }

  /**
   * Delete Working Directories nothing has used for seven days, sparing resident
   * Sessions whatever their mtime, and log each. Also runs on a timer. Returns
   * the Session ids reclaimed.
   */
  reclaimIdleWorkDirs(): string[] {
    const reclaimed: string[] = []
    for (const { sessionId, cwd, idleMs } of this.#workRoot.reclaimIdle(
      new Set(this.#residents.keys()),
    )) {
      reclaimed.push(sessionId)
      this.#log({ event: 'reclaim', sessionId, cwd, idleMs })
    }
    return reclaimed
  }

  /** End every resident process. Sessions keep their context on disk. */
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

  /** Enforced by `fence:pool-correction-is-once`. */
  async #turn(resident: Resident, text: string, corrected = false): Promise<Turn> {
    resident.busy = true
    this.#cancelReap(resident)
    try {
      return await resident.session.send(text)
    } catch (error) {
      // The process died because the pool killed it, so what the caller needs
      // is the reason it did — not the exit that carried the decision out.
      if (resident.storm !== null) throw resident.storm
      // Two spawns can be wrong about whether this Session already exists, in
      // opposite directions, and each is recoverable by trying the other flag.
      // Reaching for the other flag was the whole remedy, so a Turn that has
      // already used it has nowhere left to go.
      if (corrected) throw error
      const correction = this.#wrongFlag(resident, error)
      if (correction === null) throw error
      this.#log({
        event: correction.event,
        sessionId: resident.sessionId,
        refusal: refusalOf(resident.stderr, correction.reason),
        retryWith: correction.resume ? '--resume' : '--session-id',
      })
      // Enforced by `fence:pool-one-process-per-transcript`.
      this.#leave(resident)
      await this.#terminate(resident)
      return await this.#turn(
        // On the terms the Turn began under rather than whatever the Session is
        // on now: this is one Turn being served twice, and a `/model` or
        // `/effort` that landed in between is aimed at the next message. A
        // `Resident` already carries every term, which is what makes that
        // "the same terms" rather than a handful of fields copied by hand.
        await this.#spawn(resident.sessionId, resident, correction.resume),
        text,
        true,
      )
    } finally {
      resident.busy = false
      this.#clearRetryWatch(resident)
      // Move to the most-recently-used end here as well as on acquisition, so
      // that eviction order and the idle time it logs are the same measurement.
      // A Turn that ran for minutes finished later than one started after it.
      this.#markUsed(resident)
      this.#workRoot.touch(resident.sessionId)
      if (this.#residents.get(resident.sessionId) === resident) this.#scheduleReap(resident)
    }
  }

  async #acquire(sessionId: string, credential: CredentialKind): Promise<Resident> {
    // Enforced by `fence:pool-caveman-read-once`.
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

  /** Enforced by `fence:pool-reaches-before-the-ruleset` and `fence:pool-empty-parts-dropped-before-join`. */
  #appendSystemPromptFor(caveman: string): string | undefined {
    const said = [...this.#announcements, cavemanRuleset(caveman)]
      .filter((part) => part !== '')
      .join('\n\n')
    return said === '' ? undefined : said
  }

  async #spawn(sessionId: string, terms: SpawnTerms, resume?: boolean): Promise<Resident> {
    const spawned = this.#spawning.then(() => this.#spawnNow(sessionId, terms, resume))
    // Enforced by `fence:pool-failed-spawn-does-not-block-the-next`.
    this.#spawning = spawned.catch(() => undefined)
    return await spawned
  }

  async #spawnNow(
    sessionId: string,
    { credential, model, effort, caveman, appendSystemPrompt }: SpawnTerms,
    resume?: boolean,
  ): Promise<Resident> {
    const buildEnvFor = this.#envs[credential]
    // Refused rather than served on whichever environment does exist. A Turn run
    // on the other credential and recorded as this one is the audit record lying
    // about who paid, which is the one thing it exists not to do.
    if (buildEnvFor === undefined) {
      throw new Error(`no environment is configured for the ${credential} credential`)
    }
    await this.#makeRoom()

    const cwd = this.#workRoot.sessionDir(sessionId)
    // This file is the Session's record that it exists. Read from the filesystem
    // rather than from memory, which is what keeps the rule right across a
    // restart of roma, where every Session is one that already exists — and read
    // off the file rather than the directory, which the agent shares with
    // anything that writes into it before the Turn (#105).
    const spawnFile = join(cwd, SPAWN_FILE)
    const resuming = resume ?? existsSync(spawnFile)
    mkdirSync(cwd, { recursive: true })
    // Written on every spawn rather than only the first, so that a directory
    // from before this file existed — or one somebody removed it from — starts
    // recording again after a single recovery.
    writeFileSync(spawnFile, '')
    this.#workRoot.touch(sessionId)

    const session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnvFor(sessionId),
      resume: resuming,
      spawn: this.#spawnProcess,
      model,
      effort,
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    })
    const resident: Resident = {
      sessionId,
      cwd,
      credential,
      model,
      effort,
      caveman,
      appendSystemPrompt,
      session,
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
    session.on('turn-start', (text) => this.emit('turn-start', sessionId, text))
    session.on('turn-end', (turn) => this.emit('turn-end', sessionId, turn))
    // Kept whole rather than forwarded: it is the only place a process that
    // refuses to run at all explains itself, and `#wrongFlag` reads it.
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

  async #makeRoom(): Promise<void> {
    while (this.#residents.size >= this.#maxResident) {
      const victim = [...this.#residents.values()].find((resident) => !resident.busy)
      if (victim === undefined) {
        // Enforced by `fence:pool-busy-session-is-never-evicted`.
        throw new Error(`every one of the ${this.#residents.size} resident Sessions is busy`)
      }
      await this.#retire(victim, 'evict')
    }
  }

  async #retire(resident: Resident, event: 'evict' | 'reap'): Promise<void> {
    this.#leave(resident)
    // Enforced by `fence:pool-eviction-logged-before-termination`.
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
    // One record per swap however many terms moved, and the model wins where
    // more than one did: it is the largest fact, and every other term is on the
    // `spawn` record that follows this one either way.
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

  /**
   * End a resident's process. Never for stopping a Turn — a subsequent
   * `--resume` is what makes ending the process safe.
   */
  async #terminate(resident: Resident): Promise<void> {
    if (!resident.session.alive) return
    // Enforced by `fence:pool-own-ending-is-not-news`.
    resident.leaving = true
    await resident.session.terminateOrKill(TERMINATE_GRACE_MS, () =>
      this.#log({ event: 'kill', sessionId: resident.sessionId, graceMs: TERMINATE_GRACE_MS }),
    )
  }

  /**
   * Count one retry against the running Turn's budget, and end the Turn if it
   * has run out.
   *
   * Only while a Turn is in flight. A retry arriving outside one belongs to
   * nothing roma is waiting on, and there is no Turn for it to be the next
   * one's problem either.
   */
  #onRetry(resident: Resident, retry: ApiRetry): void {
    if (!resident.busy || resident.storm !== null) return

    let watch = resident.retry
    if (watch === null) {
      watch = { count: 1, startedAt: Date.now(), timer: null, last: retry }
      // Armed on the first retry, so the window measures how long this Turn has
      // been retrying rather than how long it has been running. A Turn that
      // works for ten minutes and then hits a bad credential gets the same
      // minute as one that hits it immediately.
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

  /** Enforced by `fence:pool-storm-ends-the-process`. */
  #abandon(resident: Resident, limit: 'retries' | 'window'): void {
    const watch = resident.retry
    if (watch === null || resident.storm !== null) return

    const elapsedMs = Date.now() - watch.startedAt
    resident.storm = new RetryStormError(watch.count, elapsedMs, watch.last)
    this.#clearRetryWatch(resident)
    this.#cancelReap(resident)
    this.#forget(resident)
    // The caller is told the status too, because a 401 is someone's to go and
    // fix. This record is what an operator gets on top of that: which Session,
    // how long it retried, and which of the two budgets ran out.
    this.#log({
      event: 'retry-storm',
      sessionId: resident.sessionId,
      retries: watch.count,
      elapsedMs,
      limit,
      status: watch.last.errorStatus,
      error: watch.last.error,
    })
    // Enforced by `fence:pool-detached-termination-is-caught`.
    void this.#terminate(resident).catch(() => {})
  }

  /**
   * End the retry watch, which is also what gives the next Turn a full budget.
   *
   * Called where a Turn ends, in `#turn`'s `finally` — a watch only ever starts
   * inside a Turn, so that is the whole of its life. The `exit` listener clears
   * it too, so that the window timer cannot outlive the process it was watching.
   */
  #clearRetryWatch(resident: Resident): void {
    if (resident.retry?.timer != null) clearTimeout(resident.retry.timer)
    resident.retry = null
  }

  #scheduleReap(resident: Resident): void {
    this.#cancelReap(resident)
    const timer = setTimeout(() => {
      // Enforced by `fence:pool-detached-termination-is-caught`.
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

  /**
   * Mark a Session as the most recently used one.
   *
   * Re-inserting is what makes this Map an LRU list: the first entry is then the
   * Session eviction takes.
   */
  #markUsed(resident: Resident): void {
    // Enforced by `fence:pool-mark-used-checks-identity`.
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

  /** Enforced by `fence:pool-wrong-flag-recovers`. */
  #wrongFlag(resident: Resident, error: unknown): Correction | null {
    // The shape production actually produces, and the branch that fires in a
    // deployment: under `--output-format stream-json` the refusal is a terminal
    // `result` on stdout, and it settles the Turn as this before the process's
    // exit ever reaches the pool. The two below are for a stream that carried no
    // terminal event, which is what plain `claude -p` does.
    //
    // Keyed on the ending rather than on what is inside it. The Session layer is
    // where a stream becomes one of roma's endings and it has already made this
    // judgement; re-deriving it here would put Claude Code's event shape in a
    // module whose job is choosing a flag.
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

/** Enforced by `fence:pool-every-term-is-compared`. */
const COMPARED: { readonly [Term in keyof SpawnTerms]: boolean } = {
  credential: true,
  model: true,
  effort: true,
  caveman: false,
  appendSystemPrompt: true,
}

/** Enforced by `fence:pool-every-term-is-compared`. */
function sameTerms(resident: Resident, terms: SpawnTerms): boolean {
  return (Object.keys(COMPARED) as (keyof SpawnTerms)[]).every(
    (term) => !COMPARED[term] || resident[term] === terms[term],
  )
}

/** How the CLI refused, for the Operator Log. Enforced by `fence:refusal-keeps-both-halves`. */
function refusalOf(stderr: string, reason: string): string {
  if (stderr.includes(reason)) return stderr
  if (stderr === '') return reason
  return `${stderr.trimEnd()}\n${reason}`
}
