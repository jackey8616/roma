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

export interface Turn {
  readonly text: string
  readonly costUsd: number | null
  readonly durationMs: number
  readonly isError: boolean
  readonly subtype: string
  readonly stopReason: string | null
  readonly terminalReason: string | null
  readonly turns: number | null
  readonly outputTokens: number | null
  readonly result: ClaudeEvent
}

const ABORTED = 'aborted_streaming'

export function wasInterrupted(turn: Turn): boolean {
  return turn.terminalReason === ABORTED
}

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

export const NO_CONVERSATION = /no conversation found/i

export class TranscriptNotFound extends TurnFailedError {
  readonly reason: string

  constructor(turn: Turn, reason: string) {
    super(turn)
    this.name = 'TranscriptNotFound'
    this.message = `resume refused, the Session has no Transcript: ${reason}`
    this.reason = reason
  }
}

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
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly resume?: boolean
  readonly model?: string
  readonly effort?: string
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

export const PINNED_MODEL = 'claude-sonnet-5'

export const PINNED_EFFORT = 'high'
const COMMAND = 'claude'

export const TERMINATE_GRACE_MS = 5_000

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
  #cumulativeCostUsd = 0
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
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      this.#model,
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

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<ClaudeProcessExit> {
    const proc = this.#process
    if (proc === null) throw new Error(`Session ${this.sessionId} has not been started`)
    if (this.#exit !== null) return this.#exit

    const exited = new Promise<ClaudeProcessExit>((resolve) => this.once('exit', resolve))
    proc.kill(signal)
    return await exited
  }

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

  #writeFrame(message: Record<string, unknown>): void {
    this.#process?.write(JSON.stringify(message) + '\n')
  }

  #onStdout(chunk: string): void {
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

    const previousTotalUsd = this.#cumulativeCostUsd
    if (result.cumulativeCostUsd !== null) this.#cumulativeCostUsd = result.cumulativeCostUsd
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
