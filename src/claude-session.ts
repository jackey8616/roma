import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  spawnRuntimeProcess,
  type RuntimeProcess,
  type RuntimeProcessExit,
  type SpawnRuntimeProcess,
} from './runtime-process.js'
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

export interface UnsolicitedTurn {
  readonly text: string
  readonly costUsd: number | null
  readonly outputTokens: number | null
  readonly isError: boolean
  readonly subtype: string
  readonly origin: string | null
  readonly resultIndex: number | null
  readonly launchedBy: string | null
  readonly result: ClaudeEvent
}

export interface LateResult {
  readonly resultIndex: number | null
  readonly isError: boolean
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
  readonly exit: RuntimeProcessExit

  constructor(exit: RuntimeProcessExit) {
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
  readonly spawn?: SpawnRuntimeProcess
}

export interface ClaudeSessionEvents {
  'turn-start': [text: string, uuid: string]
  'turn-end': [turn: Turn]
  unsolicited: [turn: UnsolicitedTurn]
  late: [late: LateResult]
  event: [event: ClaudeEvent]
  stderr: [chunk: string]
  exit: [exit: RuntimeProcessExit]
}

interface PendingTurn {
  readonly uuid: string
  readonly startedAt: number
  assistantText: string[]
  readonly settle: (turn: Turn) => void
  readonly fail: (error: Error) => void
}

export const PINNED_MODEL = 'claude-opus-5-5'

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
  readonly #spawn: SpawnRuntimeProcess

  #process: RuntimeProcess | null = null
  #exit: RuntimeProcessExit | null = null
  #pending: PendingTurn | null = null
  #background = new Set<string>()
  readonly #parents = new Map<string, string | null>()
  readonly #runs = new Map<string, string>()
  readonly #launchers = new Map<string, string>()
  #turnOpen = false
  #waking = false
  #turnOwner: string | null = null
  #wokenBy: string | null = null
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
    this.#spawn = options.spawn ?? spawnRuntimeProcess
  }

  get alive(): boolean {
    return this.#process !== null && this.#exit === null
  }

  get pid(): number | undefined {
    return this.#process?.pid
  }

  get backgroundBusy(): boolean {
    return this.#background.size > 0 || this.#turnOpen || this.#waking
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
      '--system-prompt-snapshot',
      'off',
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

    const uuid = randomUUID()
    const turn = new Promise<Turn>((resolve, reject) => {
      this.#pending = {
        uuid,
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
      uuid,
    })
    this.emit('turn-start', text, uuid)

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

  async terminate(signal: NodeJS.Signals = 'SIGTERM'): Promise<RuntimeProcessExit> {
    const proc = this.#process
    if (proc === null) throw new Error(`Session ${this.sessionId} has not been started`)
    if (this.#exit !== null) return this.#exit

    const exited = new Promise<RuntimeProcessExit>((resolve) => this.once('exit', resolve))
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
    this.#track(event)

    const result = readTerminalResult(event)
    if (result === null) return
    this.#turnOpen = false

    const previousTotalUsd = this.#cumulativeCostUsd
    if (result.cumulativeCostUsd !== null) this.#cumulativeCostUsd = result.cumulativeCostUsd
    const previousMark = this.#outputTokenMark
    if (result.cumulativeOutputTokens !== null) {
      this.#outputTokenMark = Math.max(previousMark, result.cumulativeOutputTokens)
    }

    const own = result.sinceLastResult
    const delta =
      own !== null
        ? own.costUsd
        : result.cumulativeCostUsd === null
          ? null
          : result.cumulativeCostUsd - previousTotalUsd
    const outputTokens =
      own !== null
        ? own.outputTokens
        : result.cumulativeOutputTokens === null
          ? null
          : Math.max(0, result.cumulativeOutputTokens - previousMark)

    if (pending === null || !answers(event, pending.uuid)) {
      if (pending !== null) pending.assistantText = []
      const resultIndex = typeof event['result_index'] === 'number' ? event['result_index'] : null
      if (originKind(event) !== 'task-notification') {
        this.emit('late', { resultIndex, isError: result.isError })
        return
      }
      this.#wokenBy = null
      const runId = originRunId(event)
      const taskId = runId === null ? undefined : this.#runs.get(runId)
      this.emit('unsolicited', {
        text: result.text ?? '',
        costUsd: delta,
        outputTokens,
        isError: result.isError,
        subtype: result.subtype,
        origin: originKind(event),
        resultIndex,
        launchedBy: (taskId === undefined ? undefined : this.#launchers.get(taskId)) ?? null,
        result: event,
      })
      return
    }

    const turn: Turn = {
      text: result.text ?? pending.assistantText.join(''),
      costUsd: delta,
      outputTokens,
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

  #track(event: ClaudeEvent): void {
    if (
      event.type === 'user' &&
      event['isReplay'] === true &&
      event['parent_tool_use_id'] === null &&
      typeof event['uuid'] === 'string'
    ) {
      this.#turnOwner = event['uuid']
    }
    if (event.type !== 'system') return
    const subtype = event['subtype']
    if (subtype === 'init') {
      this.#turnOpen = true
      this.#waking = false
      this.#turnOwner = this.#wokenBy
    }
    if (subtype === 'background_tasks_changed' && Array.isArray(event['tasks'])) {
      this.#background = new Set(
        (event['tasks'] as readonly Readonly<Record<string, unknown>>[])
          .filter((task) => task['ambient'] !== true && typeof task['task_id'] === 'string')
          .map((task) => task['task_id'] as string),
      )
    }
    const taskId = typeof event['task_id'] === 'string' ? event['task_id'] : null
    if (taskId === null) return
    if (subtype === 'task_started') {
      const parent = typeof event['parent_task_id'] === 'string' ? event['parent_task_id'] : null
      this.#parents.set(taskId, parent)
      if (typeof event['run_id'] === 'string') this.#runs.set(event['run_id'], taskId)
      const by = parent === null ? (this.#turnOwner ?? undefined) : this.#launchers.get(parent)
      if (by !== undefined && !this.#launchers.has(taskId)) this.#launchers.set(taskId, by)
    }
    if (
      subtype === 'task_notification' &&
      event['ambient'] !== true &&
      (this.#parents.get(taskId) ?? null) === null
    ) {
      this.#waking = true
      this.#wokenBy = this.#launchers.get(taskId) ?? null
    }
  }

  #onExit(exit: RuntimeProcessExit): void {
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

function originOf(event: ClaudeEvent): Readonly<Record<string, unknown>> | null {
  const origin = event['origin']
  return typeof origin === 'object' && origin !== null
    ? (origin as Readonly<Record<string, unknown>>)
    : null
}

function originKind(event: ClaudeEvent): string | null {
  const kind = originOf(event)?.['kind']
  return typeof kind === 'string' ? kind : null
}

function originRunId(event: ClaudeEvent): string | null {
  const runId = originOf(event)?.['runId']
  return typeof runId === 'string' ? runId : null
}

function answers(event: ClaudeEvent, uuid: string): boolean {
  const consumed = event['user_message_uuids']
  if (Array.isArray(consumed)) return consumed.includes(uuid)
  const echoed = event['user_message_uuid']
  if (typeof echoed === 'string') return echoed === uuid
  return originKind(event) !== 'task-notification'
}
