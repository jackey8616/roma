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
      /**
       * What effort its Turns run at: this Session's Chosen Effort, or the
       * Pinned Effort.
       *
       * Here for the model's reason and with one of its own: `--effort` is
       * echoed nowhere in the stream, so unlike the model there is no second
       * account of it anywhere. This line is roma saying what it put in the
       * spawn arguments, and it is the only such statement per process.
       */
      readonly effort: string
      /**
       * How short its Turns were asked to be: this Session's Chosen Caveman, or
       * the Pinned Caveman.
       *
       * Here for the effort's reason, and it is what keeps the swap below
       * readable when two terms move at once — a swap names one of them, and the
       * spawn that follows is where the others are recovered from. The *level*
       * rather than the text it renders to: what reaches the argv is several
       * thousand characters of a ruleset, and an Operator Log line is read.
       */
      readonly caveman: string
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
       * Four reasons, one shape — the way `evict` and `reap` already differ only
       * in what prompted them. A credential change is money moving between
       * bills, a model change is money moving between models, an effort change is
       * money moving between depths of thinking, and a Caveman change is money
       * moving between lengths of answer; an operator looking at an unexplained
       * respawn is asking which. Where more than one differs at once the model is
       * named first, the effort second and the Caveman third, because a model
       * change is the larger fact and because every one of the four is on the
       * `spawn` record that follows — so what a swap chooses between is which
       * *`from`* is worth keeping, and the model's is.
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
      /**
       * The same event, moving between models, efforts or Cavemen rather than
       * between bills.
       *
       * One arm for all three because they carry the same two strings; the
       * `reason` is what an operator reads them as. Deliberately not folded in
       * with the credential above, which is typed to `CredentialKind` so that a
       * model can never be logged where a bill is expected.
       */
      readonly event: 'swap'
      readonly sessionId: string
      readonly reason: 'model' | 'effort' | 'caveman'
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
      /**
       * How the CLI refused, in its own words.
       *
       * Called this rather than `stderr`, which is what it was: the refusal roma
       * meets in production arrives on *stdout* as a terminal event, and it can
       * settle the Turn before the matching stderr chunk is delivered — separate
       * pipes. So the record is written from the process's stderr where it
       * delivered any and from the ending's own reason where it did not, and a
       * field named for one pipe would be a lie in the case this record was
       * added for. Never empty either way, because this is the one line an
       * operator has to read.
       */
      readonly refusal: string
      /** The flag the Turn was retried with, so the recovery reads as one record. */
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
 * question answered and not a directory of files: `ChosenRecord` is what
 * implements it. Asked at spawn rather than handed over per call so the invariant
 * re-establishes itself after a restart — the same reason the pool reads whether
 * a Session is resuming off the filesystem instead of remembering it.
 */
export interface SessionModels {
  /**
   * Carried so that this port and `SessionEfforts` stay distinct. Enforced by
   * `fence:pool-ports-are-distinct`.
   */
  readonly kind: 'model'
  inForce(sessionId: string): string
}

/**
 * What effort a Session runs at, asked afresh at every spawn.
 *
 * `SessionModels`' twin, and a port for the same reason: what the pool needs is
 * one question answered rather than a directory of files, and asking at spawn is
 * what makes the invariant re-establish itself after a restart of roma.
 */
export interface SessionEfforts {
  /** Carried for `SessionModels.kind`'s reason. */
  readonly kind: 'effort'
  inForce(sessionId: string): string
}

/**
 * How short a Session is asked to be, asked afresh at every spawn.
 *
 * The third of these, and a port for the same reason as the first two. What it
 * answers is a *level* and never the text — the ruleset is roma's own rendering
 * of it (`cavemanRuleset`), and a port that handed over finished prose would put
 * the question "what is this Session set to" in two places, one of which cannot
 * be asked (ADR-0030).
 */
export interface SessionCavemen {
  /** Carried for `SessionModels.kind`'s reason. */
  readonly kind: 'caveman'
  inForce(sessionId: string): string
}

/**
 * What a process is started for, and therefore what its Turns run on.
 *
 * The things that are fixed at spawn and cannot be changed under a running
 * process: which bill its Turns land on, which model answers them, how hard that
 * model is asked to think, how short it is asked to be, and what it is told about
 * itself on top of Claude Code's own prompt. Named as one thing because they are
 * already one thing everywhere they are talked about — `#acquire` takes a Session
 * "for a Turn on these terms", and `#swap` ends a process because "the next
 * Turn's terms are not the ones it was started for".
 *
 * They travel together through acquisition, spawning and the swap between them,
 * and each one that arrives becomes a member here rather than another loose
 * parameter beside them. A list that grows one at a time is one where a caller
 * eventually passes the model where the effort goes and nothing says so; this
 * cannot be got wrong silently.
 *
 * The last two are one fact in two currencies, which is the only place this type
 * repeats itself and is worth the repetition: `caveman` is the word an operator
 * reads and `appendSystemPrompt` is what the argv carries. Both are here because
 * both are needed at a different moment — the append at the spawn, the level at
 * the swap, where a record naming several thousand characters of ruleset would be
 * unreadable. They are resolved together in `#acquire` and never separately.
 * Enforced by `fence:pool-caveman-read-once`.
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
  /**
   * The tree Working Directories live in, one per Session.
   *
   * The Work Root itself rather than its path, so that the layout it holds —
   * directories are Sessions, files are records — has one owner instead of being
   * a rule this pool enforced in one line and `session-generation.ts` relied on
   * from a module it does not import.
   */
  readonly workRoot: WorkRoot
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
   * What effort every Session runs at, for a pool built without `efforts`.
   *
   * `model`'s counterpart, kept for the tests that are about something else and
   * want one effort for the whole pool. `startup.ts` always supplies `efforts`.
   */
  readonly effort?: string
  /**
   * What effort each Session runs at, where somebody has chosen one.
   *
   * Omitted, every Session runs at `effort` — which is what roma did before a
   * Conversation could say otherwise.
   */
  readonly efforts?: SessionEfforts
  /**
   * How short every Session is asked to be, for a pool built without `cavemen`.
   *
   * `model`'s counterpart again, kept for the tests that are about something else
   * and want one Caveman for the whole pool. `startRoma` always supplies
   * `cavemen`.
   */
  readonly caveman?: string
  /**
   * How short each Session is asked to be, where somebody has chosen.
   *
   * Omitted, every Session is asked for `caveman` — which is what roma did
   * between ADR-0030 landing and a Conversation being able to say otherwise.
   */
  readonly cavemen?: SessionCavemen
  /**
   * What every Session is told about what roma can reach, one part per Reach.
   *
   * The pool's rather than the Core's because the pool is what spawns, and a list
   * rather than the finished text because the finished text is no longer one
   * thing: half of it is the deployment's and settled at boot, and half of it is
   * this Session's. Joining them is `#appendSystemPromptFor`'s, so that the rule
   * about empty parts is applied once rather than at both ends of a seam.
   *
   * Each part is exactly what one Reach announces, including the empty string an
   * unavailable one announces — dropped at the join rather than filtered by the
   * caller, for the same reason.
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
  readonly model: string
  /**
   * What effort this process was spawned at, and therefore what its Turns run
   * at.
   *
   * Kept for the model's reason — `--effort` is fixed at spawn, so a Session
   * whose next Turn is to run at a different effort needs a different process —
   * and it is the only place the answer exists at all: nothing in the stream
   * echoes the effort back, so a Resident that did not write this down could not
   * be asked afterwards what it was started at.
   */
  readonly effort: string
  /**
   * How short this process was asked to be, and therefore how short its Turns
   * answer.
   *
   * Kept for the effort's reason and with the same edge: nothing in the stream
   * echoes it, and here not even the argv names it — what the argv carries is the
   * ruleset this word renders to. It is also the `from` half of the swap that
   * ends this process, which is the only place the move is written as a word.
   */
  readonly caveman: string
  /**
   * What this process was told about itself on top of Claude Code's own prompt.
   *
   * Kept, and since ADR-0030 for two reasons rather than one. `#turn`'s retry
   * respawn hands a Resident straight back as its own `SpawnTerms`, so one that
   * had not written this down would re-start a Turn on whatever the pool holds by
   * then rather than on what the Turn began under — and `sameTerms` compares it,
   * because a Chosen Caveman is what makes two spawns of one deployment able to
   * disagree about it.
   */
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
   * How short the process serving this Session was asked to be, or null where
   * none is serving it.
   *
   * The Resident's own answer, never a fresh reading of the record. Enforced by
   * `fence:pool-caveman-is-what-the-process-ran-at`.
   *
   * Null for a Session with no process: a Task stopped in the queue, a
   * Conversation roma could not name a Session for, a process that died with its
   * Turn in flight. Nothing here invents a level for those, because what a
   * record says instead is the Core's — it is the only thing that knows what the
   * deployment would have given them.
   */
  cavemanOn(sessionId: string): string | null {
    return this.#residents.get(sessionId)?.caveman ?? null
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
   * The deleting is the Work Root's, which is what knows that a directory is a
   * Session and a file is a record. What is the pool's is the two things only it
   * can supply: which Sessions are resident and must survive whatever their
   * mtime says, and the announcement — an operator reads a reclaim beside an
   * Eviction and a Reaping, and those are judgements this pool made.
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
      // The Session is resident on terms this Turn is not to run on — the
      // credential it is not to be paid for by, the model it is not to run on, or
      // the effort it is not to run at. The process goes before the next one
      // starts, not because the old one is in the way but because two processes
      // on one transcript corrupt it, and "alive but idle" is not a state
      // anybody has measured as safe. The Session itself survives, as it does
      // through any eviction.
      await this.#swap(resident, terms)
    } else if (resident !== undefined) {
      this.#forget(resident)
    }
    return await this.#spawn(sessionId, terms)
  }

  /**
   * The model this Session's next process runs on.
   *
   * Read at the moment of spawning rather than held, so that a Chosen Model
   * written while roma was somewhere else — or before it last restarted — is in
   * force without anybody telling the pool about it.
   */
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

  /**
   * End a resident's process because the next Turn is not on the terms it was
   * started for.
   *
   * Its own path rather than a third kind of eviction: an eviction is roma
   * managing processes and this is money moving — between two bills, between two
   * models, or between two lengths of answer — and the two are read by different
   * people looking for different things.
   */
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
