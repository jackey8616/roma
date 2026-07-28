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
   * What this Turn cost — the delta, not the Session total.
   *
   * `total_cost_usd` on the terminal event is cumulative for the whole Session,
   * so logging it raw records the fifth Task in a Session at the sum of Tasks
   * one through five.
   */
  readonly costUsd: number
  /** Measured from `send` to the terminal event, as roma observed it. */
  readonly durationMs: number
  readonly isError: boolean
  readonly subtype: string
  readonly stopReason: string | null
  readonly terminalReason: string | null
  /** The raw terminal event, for anything this interface does not name. */
  readonly result: ClaudeEvent
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

const DEFAULT_MODEL = 'claude-sonnet-5'
const COMMAND = 'claude'

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
   * Starts at zero, which is right for a Session this process created. Whether a
   * `--resume`d process reports cost carried forward from the transcript or
   * starts again from zero is **unmeasured** — it belongs to whichever ticket
   * builds the pool, since that is where resume happens.
   */
  #cumulativeCostUsd = 0

  constructor(options: ClaudeSessionOptions) {
    super()
    this.sessionId = options.sessionId
    this.#cwd = options.cwd
    this.#env = options.env
    this.#resume = options.resume ?? false
    this.#model = options.model ?? DEFAULT_MODEL
    this.#spawn = options.spawn ?? spawnClaudeProcess
  }

  get alive(): boolean {
    return this.#process !== null && this.#exit === null
  }

  get pid(): number | undefined {
    return this.#process?.pid
  }

  /** Everything this Session has spent, as Claude Code last reported it. */
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
   * Ask Claude Code to abandon the running Turn.
   *
   * In-band over stdin, so the process survives and the next message is served
   * normally. The Turn still ends — as a failure, with whatever it had already
   * spent.
   */
  interrupt(): void {
    if (this.#process === null || this.#exit !== null) return
    this.#controlRequests += 1
    this.#writeFrame({
      type: 'control_request',
      request_id: `req_${this.#controlRequests}_${this.sessionId}`,
      request: { subtype: 'interrupt' },
    })
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
    // waiting for it. A `result` nobody asked for still moved the Session total,
    // and a baseline left behind folds that spend into the next Turn's delta —
    // which is the cumulative-total bug wearing a different hat.
    const previousTotalUsd = this.#cumulativeCostUsd
    if (result.cumulativeCostUsd !== null) this.#cumulativeCostUsd = result.cumulativeCostUsd
    if (pending === null) return

    const delta =
      result.cumulativeCostUsd === null ? 0 : result.cumulativeCostUsd - previousTotalUsd

    const turn: Turn = {
      text: result.text ?? pending.assistantText.join(''),
      costUsd: delta,
      durationMs: Date.now() - pending.startedAt,
      isError: result.isError,
      subtype: result.subtype,
      stopReason: result.stopReason,
      terminalReason: result.terminalReason,
      result: event,
    }

    this.#pending = null
    this.emit('turn-end', turn)
    if (turn.isError) pending.fail(new TurnFailedError(turn))
    else pending.settle(turn)
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
