import { EventEmitter } from 'node:events'
import {
  spawnClaudeProcess,
  type ClaudeProcess,
  type ClaudeProcessExit,
  type SpawnClaudeProcess,
} from './claude-process.js'
import {
  parseEvent,
  readAssistantText,
  readTerminalResult,
  type ClaudeEvent,
} from './stream-events.js'

/** One completed Turn: one message in, one finished response out. */
export interface Turn {
  /** What the assistant said, complete. */
  readonly text: string
  /**
   * What this Turn cost — the delta, not the running total.
   *
   * `total_cost_usd` on the terminal event is cumulative for the process, so
   * logging it raw records the fifth Task served by a process at the sum of
   * Tasks one through five.
   *
   * Null where the terminal event carried no total at all, which no capture we
   * hold does — it is what a future version that stopped reporting cost would
   * look like. Null rather than zero because the difference is the difference
   * between a Turn that was free and a Turn nobody can price, and a version that
   * quietly stopped reporting would otherwise record every Task in roma as free.
   * The baseline does not move for one of these, so the next Turn that does
   * report a total is billed from the last known one and covers both: the month
   * still adds up, and only the split between two Tasks is lost.
   */
  readonly costUsd: number | null
  /** Measured from `send` to the terminal event, as roma observed it. */
  readonly durationMs: number
  readonly isError: boolean
  readonly subtype: string
  readonly stopReason: string | null
  readonly terminalReason: string | null
  /**
   * How many model Turns this drove, or null where the event did not say.
   *
   * Zero for a message Claude Code answered locally, which is what every entry
   * on the Relay list reports on the pinned build — including the one that
   * spends money. That is why the drift check no longer reads it; see
   * `outputTokens` below and ADR-0018.
   *
   * **Nothing in the Core reads this any more**, and it is kept rather than
   * deleted for one reason: it is the field the seam 2 tests assert *is* zero on
   * a paid Relay, which is the measurement the drift check's new key exists
   * because of. A reading nothing depends on and a reading nothing records are
   * different things, and deleting it would lose the second.
   */
  readonly turns: number | null
  /**
   * The output tokens this Turn produced — what it added, not the running total.
   *
   * `modelUsage` is cumulative for the process the way `total_cost_usd` is, so
   * this is differenced here for the same reason. It is what the Relay drift
   * check reads: an entry the list declares free that produces output tokens is
   * doing model work, whatever `num_turns` says about it.
   *
   * **Never negative**, unlike `costUsd`, and `#outputTokenMark` is where that is
   * argued — the per-model breakdown is not stable across a process's life, and
   * one capture roma holds walks it backwards. This is one side of a
   * one-directional alarm rather than a figure anything is billed from, so it is
   * floored rather than reported faithfully.
   *
   * Null where the terminal event carried no `modelUsage` at all, which no
   * capture roma holds does — a free Relay reports an empty object and therefore
   * zero. Null rather than zero for the reason `costUsd` is: a build that stopped
   * reporting is a different fact from a Turn that produced nothing, and only one
   * of them should be able to retire a check.
   */
  readonly outputTokens: number | null
  /** The raw terminal event, for anything this interface does not name. */
  readonly result: ClaudeEvent
}

/**
 * What Claude Code calls a Turn that was interrupted.
 *
 * Measured, not assumed — `interrupted-turn.jsonl`, ADR-0003's run.
 *
 * Read from `terminal_reason`, never `subtype`: `error_during_execution` is what
 * any error during execution says, and only this field tells the ending somebody
 * asked for from the ones nobody did.
 */
const ABORTED = 'aborted_streaming'

/**
 * Whether this Turn ended because it was interrupted rather than because it
 * failed.
 *
 * The difference matters exactly once, at the end, where a Task somebody stopped
 * is reported as stopped rather than as a failure — the `stopped` outbound
 * instruction is where that is argued.
 */
export function wasInterrupted(turn: Turn): boolean {
  return turn.terminalReason === ABORTED
}

/**
 * A Turn that ended in failure.
 *
 * Thrown rather than returned so that no caller can mistake a failed Turn for a
 * successful one — the failure mode ADR-0003 records is a wrapper reading
 * `subtype: "success"` and reporting an auth failure as a success. The Turn
 * rides along because a failed Turn still costs money and still needs auditing.
 */
export class TurnFailedError extends Error {
  readonly turn: Turn

  constructor(turn: Turn) {
    super(
      `Turn failed (subtype=${turn.subtype}, terminal_reason=${turn.terminalReason ?? 'null'}): ${
        turn.text || '<no text>'
      }`,
    )
    this.name = 'TurnFailedError'
    this.turn = turn
  }
}

/**
 * What Claude Code says when `--resume` is pointed at a Transcript that is not
 * there.
 *
 * Measured, not assumed, and measured twice: seam 2 runs `--resume` at an
 * unknown id under plain `claude -p` and gets it on stderr
 * (`claude-session.live.test.ts`), and `resume-lost.jsonl` is the same refusal
 * under the invocation roma really spawns, where it arrives in the terminal
 * event's `errors` instead.
 *
 * Exported because both readings of the same refusal have to agree on it: this
 * module reads it off the terminal event, and the pool still reads it off
 * stderr for a process that died without emitting one. One string, so they
 * cannot drift apart.
 */
export const NO_CONVERSATION = /no conversation found/i

/**
 * A `--resume` refused because the Session it named has no Transcript.
 *
 * The fourth thing a stream can end as, and the one that is barely an ending at
 * all: nothing ran, nothing was spent, and the CLI exited before it called
 * anything. Named for the Transcript rather than for the flag, because what is
 * missing is the Transcript — the flag is only how roma found out.
 *
 * Named here rather than derived downstream because two callers want it and
 * neither can be the one that knows. The pool wants it to respawn under the
 * other flag; `reasonFor` wants it so a Conversation is told what happened
 * instead of "roma could not run this Task." Knowledge buried in the pool's
 * correction is unavailable to the second, and a second reader would have to
 * learn the stream's shape to get at it.
 *
 * A `TurnFailedError` rather than a sibling of one: a terminal event really did
 * arrive and the Turn really did end in failure, so everything that audits a
 * failed Turn goes on auditing this one. What it adds is the reason, and the
 * reason is *carried* rather than looked up — the terminal event settles the
 * Turn the moment it is parsed, and whether the process's stderr has been
 * delivered by then is not guaranteed. A recovery that reads the buffer is a
 * race; one that reads this is not.
 */
export class TranscriptNotFound extends TurnFailedError {
  /** Claude Code's own sentence, out of the terminal event rather than stderr. */
  readonly reason: string

  constructor(turn: Turn, reason: string) {
    super(turn)
    this.name = 'TranscriptNotFound'
    this.message = `resume refused, the Session has no Transcript: ${reason}`
    this.reason = reason
  }
}

/** The process died with a Turn still in flight. */
export class ClaudeExitedError extends Error {
  readonly exit: ClaudeProcessExit

  constructor(exit: ClaudeProcessExit) {
    super(`claude exited mid-Turn (code=${exit.code}, signal=${exit.signal})`)
    this.name = 'ClaudeExitedError'
    this.exit = exit
  }
}

export interface ClaudeSessionOptions {
  readonly sessionId: string
  /** The Session's own working directory. Shared ones let Sessions corrupt each other. */
  readonly cwd: string
  /** Built by `buildEnv`. Never inherited. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Whether this Session already exists on disk.
   *
   * One boolean, two flags, and no way to ask for both: `--session-id` names a
   * new Session and `--resume` reaches an existing one. Measured, not assumed —
   * the CLI rejects the pair with "--session-id can only be used with --continue
   * or --resume if --fork-session is also specified". roma never forks, so the
   * exclusion holds for every invocation roma makes.
   */
  readonly resume?: boolean
  readonly model?: string
  /**
   * How hard the model is asked to think, passed on every spawn including the
   * Sessions nobody has touched.
   *
   * Always sent, and that is what closes the shared settings file: the config dir
   * is one per deployment, and precedence was measured as
   * `CLAUDE_CODE_EFFORT_LEVEL` > `--effort` > `settings.effortLevel` — so an
   * `effortLevel` left in that file would otherwise set the effort for every
   * Session in roma, invisibly. The environment variable above it is closed by
   * `buildEnv`'s allowlist, which is why that allowlist is now load-bearing for
   * something other than credentials (ADR-0016).
   */
  readonly effort?: string
  /**
   * What this Session is told about itself on top of Claude Code's own prompt.
   *
   * A capability nobody knows about is a capability nobody has: an agent in an
   * empty directory has no reason to believe it can clone anything, and will
   * explain that it has no access rather than trying.
   *
   * `--append-system-prompt` rather than a file in the working directory,
   * because that directory is the agent's own — it clones into it and runs
   * `git add -A` in it, and anything roma left there would eventually be
   * committed into somebody's repository (ADR-0008).
   */
  readonly appendSystemPrompt?: string
  readonly spawn?: SpawnClaudeProcess
}

export interface ClaudeSessionEvents {
  'turn-start': [text: string]
  'turn-end': [turn: Turn]
  event: [event: ClaudeEvent]
  stderr: [chunk: string]
  exit: [exit: ClaudeProcessExit]
}

interface PendingTurn {
  readonly startedAt: number
  readonly assistantText: string[]
  readonly settle: (turn: Turn) => void
  readonly fail: (error: Error) => void
}

/**
 * The model every Session runs on, pinned rather than left to default.
 *
 * It is the dominant cost and capability variable and it is not stable by
 * default: it follows the credential, and the prototype watched a stray
 * `ANTHROPIC_API_KEY` move it from `claude-sonnet-5` to `claude-opus-5[1m]`
 * without a word. Pinning changes nothing that was already correct — it turns a
 * silent drift into a mismatch the startup self-check can assert on, which is
 * why that check and this constant have to name the same model.
 */
export const PINNED_MODEL = 'claude-sonnet-5'

/**
 * The effort every Session runs at, pinned rather than left to a settings file.
 *
 * `high` rather than anything else because the point of pinning is **visibility,
 * not change**: `high` was measured as what this build already falls back to when
 * nothing says otherwise, so a deployment that adopts this runs exactly as it ran
 * yesterday and gains the ability to say so. Choosing `medium` would have
 * smuggled a quiet downgrade into the same commit, at a moment when the Audit
 * Record has no effort history to notice it with. If a deployment should think
 * less, that is an operator reading their own ledger and moving `ROMA_EFFORT`
 * (ADR-0016).
 *
 * Unlike the model, nothing downstream can assert this: `system/init` carries no
 * effort field, so the startup self-check has to ask the process in prose. See
 * `startup-self-check.ts`.
 */
export const PINNED_EFFORT = 'high'
const COMMAND = 'claude'

/**
 * How long a SIGTERM is given before SIGKILL.
 *
 * Ending a process is always awaited by somebody, so a process that ignores
 * SIGTERM does not merely linger — it stalls whoever is waiting. In the pool
 * that is every later message, which is the "bot halted" state ADR-0003 lists
 * under accepted risks, reached without a single Task hanging. At startup it is
 * the boot itself.
 */
export const TERMINATE_GRACE_MS = 5_000

/**
 * One `claude -p` process, seen as a sequence of Turns.
 *
 * Everything between "here is some text" and "here is the completed answer and
 * what it cost" lives in here: process lifecycle, NDJSON framing, Turn
 * boundaries, and cost accounting. Callers get Turns and never see the stream —
 * except through `event`, which exists for progress reporting.
 */
export class ClaudeSession extends EventEmitter<ClaudeSessionEvents> {
  readonly sessionId: string

  readonly #cwd: string
  readonly #env: Readonly<Record<string, string>>
  readonly #resume: boolean
  readonly #model: string
  readonly #effort: string
  readonly #appendSystemPrompt: string | undefined
  readonly #spawn: SpawnClaudeProcess

  #process: ClaudeProcess | null = null
  #exit: ClaudeProcessExit | null = null
  #pending: PendingTurn | null = null
  #stdoutBuffer = ''
  #controlRequests = 0
  /**
   * The last `total_cost_usd` seen. Turn cost is the difference between
   * consecutive values.
   *
   * Zero for every process, resumed ones included: seam 2 measured a Session
   * that had spent $0.0822846 reporting $0.0105342 on its first Turn after
   * resuming, so the total is the *process's* and there is nothing to carry.
   */
  #cumulativeCostUsd = 0
  /**
   * The high-water mark of `modelUsage`'s output-token total, summed across
   * models. Turn output is what a terminal event reports above it.
   *
   * Zero for every process, for `#cumulativeCostUsd`'s reason.
   *
   * **A high-water mark, never a plain delta** — unlike `total_cost_usd`.
   * `modelUsage` is a breakdown that is not stable across a process's life: in
   * `three-turns-one-process.jsonl` the third Turn drops a model entry and
   * reports fewer `outputTokens` than the Turn before, while `total_cost_usd`
   * climbs as it should. A plain delta reads that as negative, and the baseline
   * it leaves makes the *next* normal Turn a large positive delta that the drift
   * check would blame on an innocent entry.
   *
   * So a backwards reading is one roma cannot use: the mark holds and that
   * Turn reports zero. Work immediately after is under-counted, which is the
   * right way round for a one-directional alarm.
   */
  #outputTokenMark = 0

  constructor(options: ClaudeSessionOptions) {
    super()
    this.sessionId = options.sessionId
    this.#cwd = options.cwd
    this.#env = options.env
    this.#resume = options.resume ?? false
    this.#model = options.model ?? PINNED_MODEL
    this.#effort = options.effort ?? PINNED_EFFORT
    this.#appendSystemPrompt = options.appendSystemPrompt
    this.#spawn = options.spawn ?? spawnClaudeProcess
  }

  get alive(): boolean {
    return this.#process !== null && this.#exit === null
  }

  get pid(): number | undefined {
    return this.#process?.pid
  }

  /**
   * Everything *this process* has spent, as Claude Code last reported it.
   *
   * Not the Session's lifetime spend: a resumed process starts counting again
   * from zero, so a Session that has been evicted has spent more than this.
   */
  get cumulativeCostUsd(): number {
    return this.#cumulativeCostUsd
  }

  get args(): string[] {
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // Not optional and not ours to drop: "When using --print,
      // --output-format=stream-json requires --verbose". A precondition of the
      // two flags above rather than a verbosity preference — without it the
      // process exits before a single event reaches the stream.
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      this.#model,
      // Unconditional, like `--model` and for a stronger reason: omitting it does
      // not fall back to nothing, it falls back to the deployment-wide settings
      // file roma neither writes nor reads. An unrecognised value here does not
      // fail the spawn either — it warns on stderr and the process starts on the
      // build's own default — which is why `ROMA_EFFORT` is validated locally at
      // boot rather than left for Claude Code to refuse.
      '--effort',
      this.#effort,
      ...(this.#appendSystemPrompt === undefined
        ? []
        : ['--append-system-prompt', this.#appendSystemPrompt]),
      ...(this.#resume ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
    ]
  }

  start(): void {
    if (this.#process !== null) throw new Error(`Session ${this.sessionId} is already started`)

    const proc = this.#spawn({
      command: COMMAND,
      args: this.args,
      cwd: this.#cwd,
      env: this.#env,
    })
    this.#process = proc

    proc.onStdout((chunk) => this.#onStdout(chunk))
    proc.onStderr((chunk) => this.emit('stderr', chunk))
    proc.onExit((exit) => this.#onExit(exit))
    proc.onError((error) => this.#failPending(error))
  }

  /**
   * Send one message and wait for the Turn it drives.
   *
   * Rejects with `TurnFailedError` if the Turn ends in failure, and with
   * `ClaudeExitedError` if the process dies first. Serialised by refusal rather
   * than by queueing: two concurrent Turns in one Session is a caller bug, and
   * the pool is where waiting belongs.
   *
   * `async` so that every way this can fail is a rejection. A method that
   * returns a promise for one class of failure and throws synchronously for
   * another cannot be handled in one place, and the caller who wrote `.catch()`
   * finds out at runtime.
   */
  async send(text: string): Promise<Turn> {
    if (this.#process === null) throw new Error(`Session ${this.sessionId} has not been started`)
    if (this.#exit !== null) throw new ClaudeExitedError(this.#exit)
    if (this.#pending !== null) {
      throw new Error(`Session ${this.sessionId} already has a Turn in flight`)
    }

    const turn = new Promise<Turn>((resolve, reject) => {
      this.#pending = {
        startedAt: Date.now(),
        assistantText: [],
        settle: resolve,
        fail: reject,
      }
    })

    this.#writeFrame({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    })
    this.emit('turn-start', text)

    return await turn
  }

  /**
   * Ask Claude Code to abandon the running Turn, and say whether there was one.
   *
   * In-band over stdin, so the process survives and the next message is served
   * normally. The Turn still ends — as a failure, with whatever it had already
   * spent.
   *
   * False means nothing was interrupted, and the caller has to be able to tell:
   * `/stop` a second after sending is a real thing for a person to do, and in
   * that second the process may still be starting. Sending the control request
   * anyway would leave the Turn to run to completion while the Conversation had
   * been told it was stopped, which is worse than saying there was nothing to
   * stop — that at least is true, and can be acted on by asking again.
   */
  interrupt(): boolean {
    if (this.#process === null || this.#exit !== null || this.#pending === null) return false
    this.#controlRequests += 1
    this.#writeFrame({
      type: 'control_request',
      request_id: `req_${this.#controlRequests}_${this.sessionId}`,
      request: { subtype: 'interrupt' },
    })
    return true
  }

  /**
   * End the process. Used for eviction, never for stopping a Turn — `--resume`
   * recovers the Session afterwards with its context intact.
   */
  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<ClaudeProcessExit> {
    const proc = this.#process
    if (proc === null) throw new Error(`Session ${this.sessionId} has not been started`)
    if (this.#exit !== null) return this.#exit

    const exited = new Promise<ClaudeProcessExit>((resolve) => this.once('exit', resolve))
    proc.kill(signal)
    return await exited
  }

  /**
   * End the process for certain — SIGTERM, then SIGKILL if it is ignored.
   *
   * `terminate` on its own waits for an exit that a wedged process never
   * produces, so every caller that *awaits* the ending needs this rather than
   * that: eviction, which holds up the next message, and the startup self-check,
   * whose whole purpose is that a boot cannot hang. The distinction is easy to
   * miss precisely because the process nearly always goes on the first signal.
   *
   * `onGraceExpired` fires only when the escalation was needed, which is the
   * moment worth recording — a process that had to be killed is a fact about
   * that process, not about the eviction that asked it to go.
   */
  async terminateOrKill(
    graceMs: number = TERMINATE_GRACE_MS,
    onGraceExpired?: () => void,
  ): Promise<void> {
    if (!this.alive) return

    let grace: NodeJS.Timeout | undefined
    const expired = new Promise<'expired'>((resolve) => {
      grace = setTimeout(() => resolve('expired'), graceMs)
      grace.unref?.()
    })
    const gone = this.terminate('SIGTERM').then(() => 'gone' as const)
    const outcome = await Promise.race([gone, expired])
    clearTimeout(grace)
    if (outcome === 'gone') return

    onGraceExpired?.()
    await this.terminate('SIGKILL')
  }

  /** One NDJSON frame onto stdin — the counterpart of the framing in `#onStdout`. */
  #writeFrame(message: Record<string, unknown>): void {
    this.#process?.write(JSON.stringify(message) + '\n')
  }

  #onStdout(chunk: string): void {
    // stdout arrives in whatever sizes the OS felt like; a line can be split
    // across any number of them, so the tail is held until its newline lands.
    this.#stdoutBuffer += chunk
    let newline: number
    while ((newline = this.#stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.#stdoutBuffer.slice(0, newline).trim()
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1)
      if (line === '') continue
      const event = parseEvent(line)
      if (event !== null) this.#onEvent(event)
    }
  }

  #onEvent(event: ClaudeEvent): void {
    const pending = this.#pending
    if (pending !== null) {
      const text = readAssistantText(event)
      if (text !== '') pending.assistantText.push(text)
    }

    this.emit('event', event)

    const result = readTerminalResult(event)
    if (result === null) return

    // Rebase the running total on every terminal event, whether or not a Turn was
    // waiting for it. A `result` nobody asked for still moved the total, and a
    // baseline left behind folds that spend into the next Turn's delta — which
    // is the cumulative-total bug wearing a different hat.
    const previousTotalUsd = this.#cumulativeCostUsd
    if (result.cumulativeCostUsd !== null) this.#cumulativeCostUsd = result.cumulativeCostUsd
    // Moved on the same terminal event, so the two figures cannot come to
    // disagree about which Turn they belong to — but only ever upwards, which is
    // where they differ. See `#outputTokenMark`.
    const previousMark = this.#outputTokenMark
    if (result.cumulativeOutputTokens !== null) {
      this.#outputTokenMark = Math.max(previousMark, result.cumulativeOutputTokens)
    }
    if (pending === null) return

    const delta =
      result.cumulativeCostUsd === null ? null : result.cumulativeCostUsd - previousTotalUsd

    const turn: Turn = {
      text: result.text ?? pending.assistantText.join(''),
      costUsd: delta,
      outputTokens:
        result.cumulativeOutputTokens === null
          ? null
          : Math.max(0, result.cumulativeOutputTokens - previousMark),
      durationMs: Date.now() - pending.startedAt,
      isError: result.isError,
      subtype: result.subtype,
      stopReason: result.stopReason,
      terminalReason: result.terminalReason,
      turns: result.turns,
      result: event,
    }

    this.#pending = null
    this.emit('turn-end', turn)
    if (!turn.isError) {
      pending.settle(turn)
      return
    }
    // Which failure this is, decided here and once. `errors` is the field that
    // separates a Turn that failed from one that never started: a 401 puts its
    // sentence in `result` and carries no `errors`, and a refused resume carries
    // `errors` and no `result` text.
    const lost = result.errors.find((entry) => NO_CONVERSATION.test(entry))
    pending.fail(
      lost === undefined ? new TurnFailedError(turn) : new TranscriptNotFound(turn, lost),
    )
  }

  #onExit(exit: ClaudeProcessExit): void {
    this.#exit = exit
    this.#failPending(new ClaudeExitedError(exit))
    this.emit('exit', exit)
  }

  #failPending(error: Error): void {
    const pending = this.#pending
    if (pending === null) return
    this.#pending = null
    pending.fail(error)
  }
}
