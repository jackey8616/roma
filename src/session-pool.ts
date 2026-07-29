import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { spawnClaudeProcess, type SpawnClaudeProcess } from './claude-process.js'
import { ClaudeExitedError, ClaudeSession, type Turn } from './claude-session.js'
import { defaultConfig, type RetryBudget } from './config.js'
import { readApiRetry, type ApiRetry, type ClaudeEvent } from './stream-events.js'

/** ADR-0003: at most ten resident processes, evicted least-recently-used. */
const MAX_RESIDENT = 10
/** ADR-0003: idle processes are reaped after fifteen minutes. */
const IDLE_REAP_MS = 15 * 60_000
/** ADR-0003: one working directory per Session, reclaimed after seven days idle. */
const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000
const RECLAIM_INTERVAL_MS = 60 * 60_000
/**
 * How long a SIGTERM is given before SIGKILL. Eviction is awaited, so a process
 * that ignores SIGTERM would otherwise stall every later message in the pool —
 * the "bot halted" state ADR-0003 lists under accepted risks, reached without a
 * single Task hanging.
 */
const TERMINATE_GRACE_MS = 5_000
/**
 * What `claude --resume` says when the transcript it was pointed at is not there.
 * Measured, not assumed — seam 2 runs `--resume` at an unknown id and gets
 * "No conversation found with session ID: …" (`claude-session.live.test.ts`).
 */
const NO_CONVERSATION = /no conversation found/i

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
      readonly residents: number
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
  | { readonly event: 'resume-lost'; readonly sessionId: string; readonly stderr: string }
  | {
      readonly event: 'reclaim'
      readonly sessionId: string
      readonly cwd: string
      readonly idleMs: number
    }

export type PoolLog = (record: PoolLogRecord) => void

/** The default log: one JSON object per line on stderr. */
export const logToStderr: PoolLog = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`)
}

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

export interface SessionPoolOptions {
  /** Working directories live directly under here, one per Session. */
  readonly workRoot: string
  /** Built by `buildEnv`, and the same for every Session in this pool. */
  readonly env: Readonly<Record<string, string>>
  readonly model?: string
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
  readonly #env: Readonly<Record<string, string>>
  readonly #model: string | undefined
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
    this.#env = options.env
    this.#model = options.model
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
  async send(sessionId: string, text: string): Promise<Turn> {
    return await this.#turn(await this.#acquire(sessionId), text)
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
   * **Known gap:** the Session's transcript belongs to Claude Code and is not
   * ours to delete, so a Conversation that goes quiet for more than seven days
   * and then comes back is created again with `--session-id` at an id that may
   * still have a transcript on disk. What the CLI does with that is unmeasured.
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

  async #turn(resident: Resident, text: string): Promise<Turn> {
    resident.busy = true
    this.#cancelReap(resident)
    try {
      return await resident.session.send(text)
    } catch (error) {
      // The process died because the pool killed it, so what the caller needs
      // is the reason it did — not the exit that carried the decision out.
      if (resident.storm !== null) throw resident.storm
      if (!this.#lostTranscript(resident, error)) throw error
      // The resume was aimed at a Session Claude Code has no transcript for.
      // Create it instead of leaving this Conversation permanently broken.
      this.#log({ event: 'resume-lost', sessionId: resident.sessionId, stderr: resident.stderr })
      this.#forget(resident)
      return await this.#turn(await this.#spawn(resident.sessionId, false), text)
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

  async #acquire(sessionId: string): Promise<Resident> {
    const resident = this.#residents.get(sessionId)
    if (resident !== undefined && resident.session.alive) {
      this.#markUsed(resident)
      return resident
    }
    if (resident !== undefined) this.#forget(resident)
    return await this.#spawn(sessionId)
  }

  async #spawn(sessionId: string, resume?: boolean): Promise<Resident> {
    const spawned = this.#spawning.then(() => this.#spawnNow(sessionId, resume))
    // The queue itself never carries a rejection onward: a Session that failed
    // to start is that caller's problem, not the next one's.
    this.#spawning = spawned.catch(() => undefined)
    return await spawned
  }

  async #spawnNow(sessionId: string, resume?: boolean): Promise<Resident> {
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
      env: this.#env,
      resume: resuming,
      spawn: this.#spawnProcess,
      ...(this.#model === undefined ? {} : { model: this.#model }),
    })
    const resident: Resident = {
      sessionId,
      cwd,
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
    // refuses to run at all explains itself, and the resume-lost check reads it.
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

  async #retire(resident: Resident, event: 'evict' | 'reap'): Promise<void> {
    this.#cancelReap(resident)
    this.#forget(resident)
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
   * SIGTERM, then SIGKILL if it is ignored. Never for stopping a Turn — a
   * subsequent `--resume` is what makes ending the process safe.
   */
  async #terminate(resident: Resident): Promise<void> {
    if (!resident.session.alive) return
    resident.leaving = true

    let grace: NodeJS.Timeout | undefined
    const expired = new Promise<'expired'>((resolve) => {
      grace = setTimeout(() => resolve('expired'), TERMINATE_GRACE_MS)
      grace.unref?.()
    })
    const gone = resident.session.terminate('SIGTERM').then(() => 'gone' as const)
    const outcome = await Promise.race([gone, expired])
    clearTimeout(grace)
    if (outcome === 'gone') return

    this.#log({ event: 'kill', sessionId: resident.sessionId, graceMs: TERMINATE_GRACE_MS })
    await resident.session.terminate('SIGKILL')
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
    if (this.#residents.delete(resident.sessionId)) {
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

  #lostTranscript(resident: Resident, error: unknown): boolean {
    return (
      resident.resumed &&
      error instanceof ClaudeExitedError &&
      NO_CONVERSATION.test(resident.stderr)
    )
  }
}
