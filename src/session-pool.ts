import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { spawnClaudeProcess, type SpawnClaudeProcess } from './claude-process.js'
import {
  ClaudeExitedError,
  ClaudeSession,
  PINNED_MODEL,
  TERMINATE_GRACE_MS,
  type Turn,
} from './claude-session.js'
import type { CredentialKind } from './build-env.js'
import { defaultConfig, type RetryBudget } from './config.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { readApiRetry, type ApiRetry, type ClaudeEvent } from './stream-events.js'

/** ADR-0003: at most ten resident processes, evicted least-recently-used. */
const MAX_RESIDENT = 10
/** ADR-0003: idle processes are reaped after fifteen minutes. */
const IDLE_REAP_MS = 15 * 60_000
/** ADR-0003: one working directory per Session, reclaimed after seven days idle. */
const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000
const RECLAIM_INTERVAL_MS = 60 * 60_000
/**
 * What `claude --resume` says when the transcript it was pointed at is not there.
 * Measured, not assumed — seam 2 runs `--resume` at an unknown id and gets
 * "No conversation found with session ID: …" (`claude-session.live.test.ts`).
 */
const NO_CONVERSATION = /no conversation found/i
/**
 * What `claude --session-id` says when a transcript for that id already exists.
 * Measured, not assumed — `docs/transcript-collision-verification.md` Q2 and Q3
 * run it at a reclaimed working directory and get "Error: Session ID … is
 * already in use." on Claude Code v2.1.220 (`#wrongFlag` is where it is read).
 */
const ALREADY_IN_USE = /session id .* is already in use/i

/**
 * One operational moment in the pool's life.
 *
 * Eviction and reaping are invisible to the person using roma by design, which
 * is exactly why an operator needs them written down: a Turn that took an extra
 * cold start is explained by a `spawn` with `resume: true`, and that record is
 * the only place the reason exists.
 */
export type PoolLogRecord =
  | {
      readonly event: 'spawn'
      readonly sessionId: string
      readonly resume: boolean
      readonly cwd: string
      /** Which of the two bills this process's Turns land on. */
      readonly credential: CredentialKind
      /**
       * Which model its Turns run on: this Session's Chosen Model, or the
       * Pinned Model.
       *
       * Here as well as on the Audit Record because the two answer different
       * questions. The record says what a Task was spent on; this says what a
       * *process* was started for, which is what makes the swap above readable —
       * a swap says the terms changed, and the spawn that follows it says what
       * they changed to.
       */
      readonly model: string
      readonly residents: number
    }
  | {
      /**
       * A process ended because the next Turn's terms are not the ones it was
       * started for.
       *
       * Its own record rather than an eviction, because an eviction is roma
       * making room and this is money moving. It is the only place the move
       * appears as something that happened to a process; what it cost appears
       * on the Task's Audit Record.
       *
       * Two reasons, one shape — the way `evict` and `reap` already differ only
       * in what prompted them. A credential change is money moving between
       * bills and a model change is money moving between models, and an operator
       * looking at an unexplained respawn is asking which. Where both differ at
       * once the model is named, because the credential is on the `spawn` record
       * that follows and the model would otherwise appear nowhere.
       *
       * `from` and `to` say what changed rather than being two fields per
       * reason, and they are typed by the reason so that a model can never land
       * in a field an operator reads as a credential.
       */
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'credential'
      readonly from: CredentialKind
      readonly to: CredentialKind
    }
  | {
      /** The same event, moving between models rather than between bills. */
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'model'
      readonly from: string
      readonly to: string
    }
  | {
      /** Both end a process the same way; they differ in what prompted it. */
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
      /**
       * A Turn abandoned mid-retry. Where an operator finds out that a
       * credential is wrong, since the caller is only told the Task is over.
       */
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
       * Both are a spawn that guessed wrong about whether the Session already
       * exists, and both are recovered by retrying with the other flag. They
       * differ in which way the guess was wrong: `resume-lost` reached for a
       * transcript that is not there, `transcript-survived` created one that is.
       */
      readonly event: 'resume-lost' | 'transcript-survived'
      readonly sessionId: string
      readonly stderr: string
      /** The flag the Turn was retried with, so the recovery reads as one record. */
      readonly retryWith: '--resume' | '--session-id'
    }
  | {
      readonly event: 'reclaim'
      readonly sessionId: string
      readonly cwd: string
      readonly idleMs: number
    }

export type PoolLog = OperatorLog<PoolLogRecord>

/** The default log: one JSON object per line on stderr. */
export const logToStderr: PoolLog = writeToStderr

/**
 * A Turn abandoned because it was retrying more than the budget allows.
 *
 * Its own class rather than a `ClaudeExitedError`, because the two are opposite
 * news: a process that died is roma failing, and this is roma deciding. The
 * caller has a Task that is over either way, but only this one can say what it
 * was over.
 */
export class RetryStormError extends Error {
  /** Retries roma saw before it stopped waiting. */
  readonly retries: number
  /** How long the Turn had been retrying, from its first retry. */
  readonly elapsedMs: number
  /**
   * The last retry seen, and the only account of the underlying failure roma
   * has: the error proper surfaces after the retries are exhausted, which is
   * exactly the wait being cut short here.
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
 * One Session's environment, built by `buildEnv`.
 *
 * A function of the Session rather than one map reused for every process,
 * because two of the variables in it are the Session's own — the id a Credential
 * Shim reports a request under, and nothing else that differs. Everything
 * expensive or secret is closed over once at startup; this only fills in who is
 * asking.
 */
export type BuildSessionEnv = (sessionId: string) => Readonly<Record<string, string>>

/**
 * The environment to spawn with for each credential a Turn can be paid for by.
 *
 * Partial, because Overflow is configuration a deployment may not have: no
 * metered key, no entry, and a Turn that asks for one is refused rather than
 * quietly served on the subscription. ADR-0002's point exactly — Overflow is not
 * a mode, it is the other environment map.
 */
export type CredentialEnvs = Readonly<Partial<Record<CredentialKind, BuildSessionEnv>>>

/**
 * Which model a Session runs on, asked afresh at every spawn.
 *
 * A port rather than the record itself, because what the pool needs is one
 * question answered and not a directory of files: `ChosenModels` is what
 * implements it. Asked at spawn rather than handed over per call so the invariant
 * re-establishes itself after a restart — the same reason the pool reads whether
 * a Session is resuming off the filesystem instead of remembering it.
 */
export interface SessionModels {
  modelFor(sessionId: string): string
}

export interface SessionPoolOptions {
  /** Working directories live directly under here, one per Session. */
  readonly workRoot: string
  /** One environment per credential a Turn may run on. */
  readonly envs: CredentialEnvs
  /**
   * The model every Session runs on, for a pool built without `models`.
   *
   * No longer how roma runs: `startup.ts` always supplies `models`, which
   * answers per Session and makes this unreachable in production. It is kept for
   * the tests that are about something else and want one model for the whole
   * pool, and saying so is the point — a reader who found it described as "the
   * fallback" would go looking for the deployment that takes it.
   */
  readonly model?: string
  /**
   * Which model each Session runs on, where somebody has chosen one.
   *
   * Omitted, every Session runs on `model` — which is what roma did before a
   * Conversation could say otherwise.
   */
  readonly models?: SessionModels
  /**
   * What every Session is told about itself on top of Claude Code's own prompt.
   *
   * The pool's rather than the Core's because the pool is what spawns, and it is
   * the same text for every Session: what it says is what roma can reach, which
   * is a property of the deployment and not of any Conversation.
   */
  readonly appendSystemPrompt?: string
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
  /** The wall-clock backstop, armed on the first retry. */
  timer: NodeJS.Timeout | null
  last: ApiRetry
}

interface Resident {
  readonly sessionId: string
  readonly cwd: string
  /**
   * Which credential this process was spawned on, and therefore which one its
   * Turns are billed to.
   *
   * Kept because it is the process that carries a credential, not the Session:
   * a Session's next Turn can be paid for by the other one, and the only way to
   * serve it is a different process — two on one transcript is the corruption
   * the whole serialisation rule exists to prevent.
   */
  readonly credential: CredentialKind
  /**
   * Which model this process was spawned on, and therefore which one its Turns
   * run on.
   *
   * Kept for the reason the credential is: `--model` is fixed at spawn, so a
   * Session whose next Turn is to run on a different model needs a different
   * process. It is also what makes a Task finish on the model it started under —
   * a `/model` mid-Turn moves what the *next* acquisition compares against and
   * cannot reach the process already serving somebody.
   */
  readonly model: string
  readonly session: ClaudeSession
  /** Whether this process was started with `--resume`. */
  readonly resumed: boolean
  stderr: string
  busy: boolean
  lastUsedAt: number
  reapTimer: NodeJS.Timeout | null
  /** Set when the pool is the one ending the process, so its exit is not news. */
  leaving: boolean
  /** Null until the running Turn's first retry, and again once it ends. */
  retry: RetryWatch | null
  /** Set when this Turn was abandoned, so its process's death is explained. */
  storm: RetryStormError | null
}

/**
 * Resident Sessions: which Claude Code processes are alive, and for how long.
 *
 * A Session outlives any one process. Callers send a message to a Session id and
 * get back a Turn; whether that was served by a process already running, one
 * resumed from disk, or one created for the first time is the pool's business
 * and nothing else's. Eviction and reaping are therefore invisible except in the
 * log and in how long the Turn took.
 *
 * What the pool owns, and why it has to be here rather than in `ClaudeSession`:
 *
 * - **First spawn versus resume.** `--session-id` names a new Session and
 *   `--resume` reaches an existing one, and the CLI refuses both together. Only
 *   something that outlives the process can tell which case it is in.
 * - **Who gets evicted.** A Session with a Turn in flight never does.
 *
 * What it deliberately does *not* own is cost, though it nearly had to.
 * `total_cost_usd` turned out to be cumulative for the process rather than for
 * the Session, so a resumed process has nothing to carry forward and there is no
 * baseline to keep here. Measured at seam 2; the figures are in ADR-0003's
 * observability section.
 */
export class SessionPool extends EventEmitter<SessionPoolEvents> {
  readonly #workRoot: string
  readonly #envs: CredentialEnvs
  readonly #model: string | undefined
  readonly #models: SessionModels | undefined
  readonly #appendSystemPrompt: string | undefined
  readonly #maxResident: number
  readonly #retryBudget: RetryBudget
  readonly #spawnProcess: SpawnClaudeProcess
  readonly #log: PoolLog

  /** Insertion-ordered, so the first entry is the least recently used. */
  readonly #residents = new Map<string, Resident>()
  /**
   * Spawns run one at a time.
   *
   * Making room and taking the slot have to be a single step. Two Sessions
   * arriving together at a pool one short of full would each look, each see a
   * free slot, and each take it — and a cap of ten would quietly hold eleven
   * processes. The wait is bounded by one eviction.
   */
  #spawning: Promise<unknown> = Promise.resolve()
  readonly #reclaimTimer: NodeJS.Timeout

  constructor(options: SessionPoolOptions) {
    super()
    this.#workRoot = options.workRoot
    this.#envs = options.envs
    this.#model = options.model
    this.#models = options.models
    this.#appendSystemPrompt = options.appendSystemPrompt
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
   * Where a Session's Working Directory is, resident or not.
   *
   * Here because the pool owns the work root and nothing else knows it, and the
   * Core needs the path to write an Enclosure into before the Turn that reads
   * it (ADR-0011). A pure derivation: it makes no directory and asks the
   * filesystem nothing, so a Session that has never run has an answer too —
   * which is the case that matters, since the first message to a Conversation
   * is as likely to carry an Enclosure as any other.
   */
  cwdFor(sessionId: string): string {
    return join(this.#workRoot, sessionId)
  }

  /**
   * Send one message to a Session and wait for the Turn it drives.
   *
   * The Session is made resident first — resumed or created as needed — and is
   * pinned against eviction until the Turn ends. Serialisation between Tasks is
   * not done here: two concurrent messages to one Session is a caller bug, and
   * queueing belongs to the Task queue.
   *
   * Rejects with `RetryStormError` if the Turn spends its retry budget, which
   * is the one way a Turn ends that nobody asked for.
   */
  async send(
    sessionId: string,
    text: string,
    credential: CredentialKind = 'shared-window',
  ): Promise<Turn> {
    return await this.#turn(await this.#acquire(sessionId, credential), text)
  }

  /**
   * Ask a resident Session to abandon its running Turn. Its process survives.
   *
   * False if there was no Turn to abandon — including the case where the Session
   * is not resident at all, which is what a Conversation that has been quiet all
   * morning looks like.
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
   * Delete working directories nothing has used for seven days.
   *
   * Runs on a timer as well, because a directory only goes stale by *not* being
   * used and nothing else would ever come and look.
   *
   * The Transcript is deliberately left behind. It belongs to Claude Code and
   * ADR-0006 upheld that it is not roma's to delete, so a Conversation that goes
   * quiet for more than seven days comes back to a directory that is gone and a
   * Transcript that is not. That used to be a known gap with an unmeasured
   * outcome; it is measured now, and `#wrongFlag` is where it is handled — the
   * spawn is refused as already in use and the Turn retries with `--resume`,
   * which reaches the Session having forgotten nothing.
   */
  reclaimIdleWorkDirs(): string[] {
    let entries
    try {
      entries = readdirSync(this.#workRoot, { withFileTypes: true })
    } catch {
      return []
    }

    const now = Date.now()
    const reclaimed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      if (this.#residents.has(sessionId)) continue

      const cwd = join(this.#workRoot, sessionId)
      let idleMs: number
      try {
        idleMs = now - statSync(cwd).mtimeMs
      } catch {
        continue
      }
      if (idleMs < WORK_DIR_TTL_MS) continue

      rmSync(cwd, { recursive: true, force: true })
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

  /**
   * Run one Turn on a resident, correcting a spawn that guessed wrong once.
   *
   * `corrected` is what bounds that to once, and it has to be carried rather
   * than inferred. Each correction flips the flag, so the *opposite* diagnosis
   * becomes available to the retry — and a CLI that refuses whichever flag it is
   * given would otherwise be answered with `--session-id`, `--resume`,
   * `--session-id`, for as long as the pool is willing to spawn. `#spawn` is
   * serialised through `#spawning`, so that loop would starve every other
   * Session as well as this one.
   */
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
        stderr: resident.stderr,
        retryWith: correction.resume ? '--resume' : '--session-id',
      })
      this.#forget(resident)
      return await this.#turn(
        // On the model the Turn began under rather than whatever the Session is
        // on now: this is one Turn being served twice, and a `/model` that landed
        // in between is aimed at the next message.
        await this.#spawn(resident.sessionId, resident.credential, resident.model, correction.resume),
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
      this.#touch(resident.cwd)
      if (this.#residents.get(resident.sessionId) === resident) this.#scheduleReap(resident)
    }
  }

  /**
   * Take a Session for a Turn on these terms, on a process started for them.
   *
   * The invariant rather than an effect somebody performs: a Turn runs on the
   * credential it is to be paid for by and on the model its Session is on, and
   * this is the one place that is made true. Stated here, it cannot be forgotten
   * by a later caller and it re-establishes itself after a restart — which is why
   * `/model` writes a record and tears nothing down.
   */
  async #acquire(sessionId: string, credential: CredentialKind): Promise<Resident> {
    const model = this.#modelFor(sessionId)
    const resident = this.#residents.get(sessionId)
    if (resident !== undefined && resident.session.alive) {
      if (resident.credential === credential && resident.model === model) {
        this.#markUsed(resident)
        return resident
      }
      // The Session is resident on terms this Turn is not to run on — the
      // credential it is not to be paid for by, or the model it is not to run on.
      // The process goes before the next one starts, not because the old one is
      // in the way but because two processes on one transcript corrupt it, and
      // "alive but idle" is not a state anybody has measured as safe. The Session
      // itself survives, as it does through any eviction.
      await this.#swap(resident, credential, model)
    } else if (resident !== undefined) {
      this.#forget(resident)
    }
    return await this.#spawn(sessionId, credential, model)
  }

  /**
   * The model this Session's next process runs on.
   *
   * Read at the moment of spawning rather than held, so that a Chosen Model
   * written while roma was somewhere else — or before it last restarted — is in
   * force without anybody telling the pool about it.
   */
  #modelFor(sessionId: string): string {
    return this.#models?.modelFor(sessionId) ?? this.#model ?? PINNED_MODEL
  }

  async #spawn(
    sessionId: string,
    credential: CredentialKind,
    model: string,
    resume?: boolean,
  ): Promise<Resident> {
    const spawned = this.#spawning.then(() => this.#spawnNow(sessionId, credential, model, resume))
    // The queue itself never carries a rejection onward: a Session that failed
    // to start is that caller's problem, not the next one's.
    this.#spawning = spawned.catch(() => undefined)
    return await spawned
  }

  async #spawnNow(
    sessionId: string,
    credential: CredentialKind,
    model: string,
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

    const cwd = join(this.#workRoot, sessionId)
    // The working directory is the Session's record that it exists. Reading it
    // from the filesystem rather than from memory is what keeps the rule right
    // across a restart of roma, where every Session is one that already exists.
    const resuming = resume ?? existsSync(cwd)
    mkdirSync(cwd, { recursive: true })
    this.#touch(cwd)

    const session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnvFor(sessionId),
      resume: resuming,
      spawn: this.#spawnProcess,
      model,
      ...(this.#appendSystemPrompt === undefined
        ? {}
        : { appendSystemPrompt: this.#appendSystemPrompt }),
    })
    const resident: Resident = {
      sessionId,
      cwd,
      credential,
      model,
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
      residents: this.#residents.size,
    })
    this.#scheduleReap(resident)
    return resident
  }

  async #makeRoom(): Promise<void> {
    while (this.#residents.size >= this.#maxResident) {
      // Map order is LRU order, so this is the least recently used Session that
      // is not in the middle of a Turn.
      const victim = [...this.#residents.values()].find((resident) => !resident.busy)
      if (victim === undefined) {
        // Reached only if the Task queue's concurrency cap is ever raised to the
        // resident cap or above, since only a running Task makes a Session busy.
        // Refusing loudly beats evicting a Session out from under a running Turn,
        // which would fail a Task that was doing nothing wrong.
        throw new Error(`every one of the ${this.#residents.size} resident Sessions is busy`)
      }
      await this.#retire(victim, 'evict')
    }
  }

  /** End a resident's process because roma wants its slot or its idleness back. */
  async #retire(resident: Resident, event: 'evict' | 'reap'): Promise<void> {
    this.#leave(resident)
    // Logged before the signal rather than after: this is the moment an operator
    // is looking for, and a termination that hangs must not swallow it.
    this.#log({
      event,
      sessionId: resident.sessionId,
      idleMs: Date.now() - resident.lastUsedAt,
      residents: this.#residents.size,
    })
    await this.#terminate(resident)
  }

  /**
   * End a resident's process because the next Turn is not on the terms it was
   * started for.
   *
   * Its own path rather than a third kind of eviction: an eviction is roma
   * managing processes and this is money moving — between two bills, or between
   * two models — and the two are read by different people looking for different
   * things.
   */
  async #swap(resident: Resident, to: CredentialKind, model: string): Promise<void> {
    this.#leave(resident)
    const sessionId = resident.sessionId
    this.#log(
      resident.model === model
        ? { event: 'swap', sessionId, reason: 'credential', from: resident.credential, to }
        : { event: 'swap', sessionId, reason: 'model', from: resident.model, to: model },
    )
    await this.#terminate(resident)
  }

  /** Take a resident out of the pool, ahead of ending its process. */
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
    // Set before the signal, so that the exit this causes is not logged as news.
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

  /**
   * Stop waiting on a Turn that is only retrying, and give its slot back.
   *
   * The process goes rather than the Turn being interrupted. An interrupt is
   * measured against a process that is *working* — ~20ms, and it stays alive —
   * and says nothing about one asleep in a 35-second backoff. This cap exists
   * precisely for the case where the process is not doing what roma hopes, so
   * it uses the ending that does not depend on the process agreeing to it. The
   * Session survives: the next message resumes it from the transcript on disk.
   */
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
    // Not awaited: the Turn's own rejection is what the caller is waiting on,
    // and it arrives with the process's exit. Termination cannot reject —
    // signals and waiting — and the catch is here so it can never become an
    // unhandled rejection either.
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
      // Cannot reject: termination is signals and waiting. The catch is here so
      // that a timer can never turn into an unhandled rejection.
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
   * Re-inserting is what makes this Map an LRU list — the first entry is then
   * the Session that has gone longest without being touched, which is the one
   * eviction takes.
   */
  #markUsed(resident: Resident): void {
    // Identity, not presence — the same check `#forget` makes, and for the same
    // reason. A recovery replaces the resident under a Turn that is still
    // running, so this can be reached for one that has already been supplanted;
    // re-inserting on presence alone would put the dead one back over the live
    // one and orphan a working process.
    if (this.#residents.get(resident.sessionId) === resident) {
      this.#residents.delete(resident.sessionId)
      this.#residents.set(resident.sessionId, resident)
    }
    resident.lastUsedAt = Date.now()
  }

  /** Drop a resident, unless the slot has already been taken by a newer process. */
  #forget(resident: Resident): void {
    if (this.#residents.get(resident.sessionId) === resident) {
      this.#residents.delete(resident.sessionId)
    }
  }

  /** The working directory's mtime is how long the Session has been idle. */
  #touch(cwd: string): void {
    const seconds = Date.now() / 1000
    try {
      utimesSync(cwd, seconds, seconds)
    } catch {
      // A directory reclaimed underneath us is not worth failing a Turn over.
    }
  }

  /**
   * A spawn refused because the flag was wrong about whether the Session exists,
   * and which flag to try instead. Null for every other failure.
   *
   * The working directory is the pool's record of existence, and it can be wrong
   * both ways. It exists before the first spawn, so a Session that died before
   * Claude Code wrote its transcript looks created and is not — `--resume` finds
   * nothing. It is deleted by the seven-day reclaim while the transcript stays,
   * so a Conversation that went quiet looks new and is not — `--session-id` hits
   * a transcript that is still there. Left alone either one poisons that
   * Conversation for good, because every later message repeats the same spawn.
   *
   * Reacting to what the CLI said rather than reading the transcript's own path
   * to decide up front: that path is
   * `$CLAUDE_CONFIG_DIR/projects/<slug-of-cwd>/<id>.jsonl`, undocumented and
   * Claude Code's to change, and ADR-0006 keeps the pool from knowing the config
   * directory at all. A wasted spawn costs a process that exits immediately.
   */
  #wrongFlag(
    resident: Resident,
    error: unknown,
  ): { readonly event: 'resume-lost' | 'transcript-survived'; readonly resume: boolean } | null {
    if (!(error instanceof ClaudeExitedError)) return null
    if (resident.resumed) {
      return NO_CONVERSATION.test(resident.stderr) ? { event: 'resume-lost', resume: false } : null
    }
    return ALREADY_IN_USE.test(resident.stderr)
      ? { event: 'transcript-survived', resume: true }
      : null
  }
}
