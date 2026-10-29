import type { ClaudeProcess, SpawnClaudeProcess } from './claude-process.js'
import { spawnClaudeProcess } from './claude-process.js'

/**
 * A `codex app-server` process, spoken to over JSON-RPC on stdio — the harness
 * #149 asks for, and the floor ADR-0026's verification agenda stands on.
 *
 * Deliberately not a Session. It is not owned by the Session Pool, it does not
 * resume, it has no wedge watchdog and it answers no approval — each of those is
 * an agenda item this module exists to make askable (#151, #156, #153). What it
 * does hold is the wire: a request is matched to its reply by id, notifications
 * are routed to the one Turn running, and a process that dies fails everything
 * still waiting rather than leaving it to a timeout.
 *
 * Every method and field name here is the pinned build's own
 * (`codex app-server generate-ts`); `docs/codex-app-server-verification.md`
 * records where that disagrees with ADR-0026.
 */
export class CodexAppServer {
  readonly #process: ClaudeProcess
  readonly #pending = new Map<number, Pending>()
  readonly #stderr: string[] = []
  readonly #exit: Promise<void>
  #nextId = 1
  #buffered = ''
  #turn: RunningTurn | null = null
  #lostBecause: string | null = null

  constructor({
    codexHome,
    cwd,
    inherit = {},
    command = 'codex',
    spawn = spawnClaudeProcess,
  }: CodexAppServerOptions) {
    this.#process = spawn({
      command,
      args: ['app-server'],
      cwd,
      // Last, so an inherited `CODEX_HOME` can never point the process at a
      // credential other than the one the deployment named.
      env: { ...inherit, CODEX_HOME: codexHome },
    })
    this.#process.onStdout((chunk) => this.#read(chunk))
    this.#process.onStderr((chunk) => this.#keepStderr(chunk))
    this.#exit = new Promise((resolve) => {
      this.#process.onExit(({ code, signal }) => {
        this.#lose(`codex app-server exited (code ${code}, signal ${signal})`)
        resolve()
      })
      this.#process.onError((error) => {
        this.#lose(`codex app-server could not run: ${error.message}`)
        resolve()
      })
    })
  }

  /** The last lines the process wrote to stderr, for a failure that needs explaining. */
  get stderr(): readonly string[] {
    return this.#stderr
  }

  /**
   * The handshake: `initialize`, then the `initialized` notification the
   * protocol requires before it serves anything else.
   */
  async initialize(clientVersion: string): Promise<CodexInitialized> {
    const result = await this.#request('initialize', {
      clientInfo: { name: 'roma', title: null, version: clientVersion },
      // Only the stable surface: anything roma relies on must be in the build it
      // pins without an opt-in that build may drop.
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    this.#send({ method: 'initialized' })
    return {
      userAgent: stringField(result, 'userAgent'),
      codexHome: stringField(result, 'codexHome'),
    }
  }

  /**
   * Start a thread on a model, and report what the server says it started it on.
   *
   * There is no effort here because the pinned build's `thread/start` takes none;
   * it travels on `runTurn`. Approvals are off: a harness Turn has nobody to
   * approve anything, and the posture a served Session runs under is #153's.
   */
  async startThread({ model, cwd }: CodexThreadRequest): Promise<CodexThread> {
    const result = await this.#request('thread/start', { model, cwd, approvalPolicy: 'never' })
    return {
      threadId: stringField(objectField(result, 'thread'), 'id'),
      model: stringField(result, 'model'),
      reasoningEffort: nullableStringField(result, 'reasoningEffort'),
    }
  }

  /**
   * One Turn, from `turn/start` to `turn/completed`. One at a time per process.
   *
   * The reply is the text of the Turn's completed `agentMessage` items, in order.
   * Usage is the last `thread/tokenUsage/updated` reading for the thread, because
   * the pinned build puts none on `turn/completed`.
   */
  async runTurn({ threadId, text, effort }: CodexTurnRequest): Promise<CodexTurn> {
    if (this.#turn !== null) throw new Error('a Turn is already running on this app-server')

    const turn: RunningTurn = {
      threadId,
      messages: [],
      tokenUsage: null,
      usageProblem: null,
      completed: deferred<CodexTurn>(),
    }
    this.#turn = turn
    try {
      await this.#request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(effort === undefined ? {} : { effort }),
      })
      return await turn.completed.promise
    } finally {
      this.#turn = null
    }
  }

  /** Close stdin and wait for the process to go, killing it if it outstays `graceMs`. */
  async close(graceMs = 5_000): Promise<void> {
    if (this.#lostBecause !== null) return
    this.#process.closeStdin()
    const timer = setTimeout(() => this.#process.kill('SIGKILL'), graceMs)
    await this.#exit
    clearTimeout(timer)
  }

  /** Send one request and wait for the reply carrying its id. */
  #request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#lostBecause !== null) {
      return Promise.reject(new CodexAppServerLost(this.#lostBecause, this.#stderr))
    }
    const id = this.#nextId++
    const reply = deferred<Record<string, unknown>>()
    this.#pending.set(id, { method, reply })
    this.#send({ id, method, params })
    return reply.promise
  }

  /** One message, one line — the wire's whole framing. */
  #send(message: Record<string, unknown>): void {
    this.#process.write(`${JSON.stringify(message)}\n`)
  }

  /** Split stdout into lines, keeping a partial one for the next chunk. */
  #read(chunk: string): void {
    this.#buffered += chunk
    const lines = this.#buffered.split('\n')
    this.#buffered = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') this.#dispatch(line)
  }

  /** Route one line to the reply, server request or notification it is. */
  #dispatch(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Kept where a failure is explained from: a throw out of a stream listener
      // has nobody waiting to catch it.
      this.#keepStderr(`<not JSON on stdout> ${line.slice(0, 200)}`)
      return
    }
    const record = recordOrEmpty(message)
    const { id, method } = record
    if (typeof method === 'string') {
      if (id === undefined) this.#notification(method, recordOrEmpty(record['params']))
      else this.#decline(id, method)
    } else if (typeof id === 'number') {
      this.#reply(id, record)
    } else {
      // A reply with `id: null` is the server saying it could not read a request,
      // and whichever one it was now waits for the process to end.
      this.#keepStderr(`<unroutable on stdout> ${line.slice(0, 200)}`)
    }
  }

  /** Settle the request a reply answers. */
  #reply(id: number, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)

    const error = message['error']
    if (isRecord(error)) {
      const { code, message: text } = error
      pending.reply.reject(
        new CodexRpcError(
          pending.method,
          typeof code === 'number' ? code : null,
          typeof text === 'string' ? text : JSON.stringify(error),
        ),
      )
    } else {
      pending.reply.resolve(recordOrEmpty(message['result']))
    }
  }

  /** Refuse a server request, so the server is not left waiting for an answer. */
  #decline(id: unknown, method: string): void {
    this.#send({
      id,
      error: { code: -32601, message: `roma does not answer ${method} from this harness` },
    })
  }

  /** Fold one notification into the running Turn, where it is that Turn's thread's. */
  #notification(method: string, params: Record<string, unknown>): void {
    const turn = this.#turn
    if (turn === null || params['threadId'] !== turn.threadId) return

    switch (method) {
      case 'item/completed': {
        const item = recordOrEmpty(params['item'])
        if (item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
          turn.messages.push(item['text'])
        }
        return
      }
      case 'thread/tokenUsage/updated': {
        // Never reject `completed` here: that ends `runTurn` while the server's
        // Turn is still running, frees the one-Turn guard, and the next
        // `turn/start` steers the old Turn instead of starting a new one.
        const usage = readTokenUsage(params['tokenUsage'])
        if (usage === null) {
          turn.usageProblem ??= `thread/tokenUsage/updated carried no usage: ${JSON.stringify(params)}`
        } else {
          turn.tokenUsage = usage
        }
        return
      }
      case 'turn/completed':
        this.#complete(turn, recordOrEmpty(params['turn']))
        return
    }
  }

  /** Settle the running Turn from its `turn/completed`, refusing a shape this build never sends. */
  #complete(turn: RunningTurn, completed: Record<string, unknown>): void {
    const { id, status } = completed
    if (typeof id !== 'string' || !isTurnStatus(status)) {
      turn.completed.reject(
        new Error(`turn/completed carried no finished Turn: ${JSON.stringify(completed)}`),
      )
      return
    }
    if (turn.usageProblem !== null) {
      turn.completed.reject(new Error(turn.usageProblem))
      return
    }
    const error = recordOrEmpty(completed['error'])
    turn.completed.resolve({
      turnId: id,
      status,
      text: turn.messages.join('\n\n'),
      error: typeof error['message'] === 'string' ? error['message'] : null,
      tokenUsage: turn.tokenUsage,
    })
  }

  /** Fail everything still waiting, once, because nothing will answer it now. */
  #lose(reason: string): void {
    if (this.#lostBecause !== null) return
    this.#lostBecause = reason
    const lost = new CodexAppServerLost(reason, this.#stderr)
    for (const { reply } of this.#pending.values()) reply.reject(lost)
    this.#pending.clear()
    this.#turn?.completed.reject(lost)
  }

  /** Keep the last `STDERR_LINES` lines of stderr. */
  #keepStderr(chunk: string): void {
    this.#stderr.push(...chunk.split('\n').filter((line) => line !== ''))
    if (this.#stderr.length > STDERR_LINES) {
      this.#stderr.splice(0, this.#stderr.length - STDERR_LINES)
    }
  }
}

export interface CodexAppServerOptions {
  /**
   * The `CODEX_HOME` the process runs under — the deployment's writable mount,
   * holding the operator-seeded `auth.json` (ADR-0026 *The home*).
   */
  readonly codexHome: string
  /** Where the process itself starts. A thread names its own working directory. */
  readonly cwd: string
  /** The environment beneath `CODEX_HOME`. Nothing by default. */
  readonly inherit?: Readonly<Record<string, string>>
  readonly command?: string
  readonly spawn?: SpawnClaudeProcess
}

/** What the handshake said back. */
export interface CodexInitialized {
  readonly userAgent: string
  /** The `CODEX_HOME` the server resolved — which should be the one it was handed. */
  readonly codexHome: string
}

export interface CodexThreadRequest {
  readonly model: string
  readonly cwd: string
}

/** A thread, as the server says it was started. */
export interface CodexThread {
  readonly threadId: string
  readonly model: string
  /** Null where the server named none — which it does when nobody sent one. */
  readonly reasoningEffort: string | null
}

export interface CodexTurnRequest {
  readonly threadId: string
  readonly text: string
  /** Sent on `turn/start` where given, and then sticks to the thread. */
  readonly effort?: string
}

/** One finished Turn. */
export interface CodexTurn {
  readonly turnId: string
  readonly status: CodexTurnStatus
  readonly text: string
  /** The server's own sentence for a failed or interrupted Turn. */
  readonly error: string | null
  /** The last usage reading for the Turn's thread, or null where none came. */
  readonly tokenUsage: CodexTokenUsage | null
}

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed'

/** One `thread/tokenUsage/updated` reading: the thread's running total, and the last call's. */
export interface CodexTokenUsage {
  readonly total: CodexTokenBreakdown
  readonly last: CodexTokenBreakdown
}

/** The build's `TokenUsageBreakdown`, field for field. */
export interface CodexTokenBreakdown {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteInputTokens: number
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
}

/** The server answered a request with an error. */
export class CodexRpcError extends Error {
  readonly method: string
  readonly code: number | null

  constructor(method: string, code: number | null, message: string) {
    super(`${method} failed${code === null ? '' : ` (${code})`}: ${message}`)
    this.name = 'CodexRpcError'
    this.method = method
    this.code = code
  }
}

/** The process went away, so nothing still waiting on it will be answered. */
export class CodexAppServerLost extends Error {
  readonly stderr: readonly string[]

  constructor(reason: string, stderr: readonly string[]) {
    super(stderr.length === 0 ? reason : `${reason}\n${stderr.slice(-STDERR_TAIL).join('\n')}`)
    this.name = 'CodexAppServerLost'
    this.stderr = [...stderr]
  }
}

/** Lines of stderr kept. */
const STDERR_LINES = 200
/** Lines of stderr a lost process quotes. */
const STDERR_TAIL = 20

/** A request waiting for its reply. */
interface Pending {
  readonly method: string
  readonly reply: Deferred<Record<string, unknown>>
}

/** The Turn in flight, and what its notifications have said so far. */
interface RunningTurn {
  readonly threadId: string
  readonly messages: string[]
  tokenUsage: CodexTokenUsage | null
  /** The first usage reading that could not be read, refused once the Turn ends. */
  usageProblem: string | null
  readonly completed: Deferred<CodexTurn>
}

/** What `deferred` returns. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

/** A promise with its settle functions held outside it. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Never remove this: a Turn lost before `turn/start` is answered rejects
  // `completed` with nobody awaiting it yet, and Node ends the process on an
  // unhandled rejection. Whoever awaits it later still sees the error.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** A usage reading, or null where it is not the shape the build documents — which the caller refuses. */
function readTokenUsage(value: unknown): CodexTokenUsage | null {
  if (!isRecord(value)) return null
  const total = readBreakdown(value['total'])
  const last = readBreakdown(value['last'])
  return total === null || last === null ? null : { total, last }
}

/** One breakdown, or null where any field is missing. */
function readBreakdown(value: unknown): CodexTokenBreakdown | null {
  if (!isRecord(value)) return null
  const {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  } = value
  if (
    typeof totalTokens !== 'number' ||
    typeof inputTokens !== 'number' ||
    typeof cachedInputTokens !== 'number' ||
    typeof cacheWriteInputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof reasoningOutputTokens !== 'number'
  ) {
    return null
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  }
}

/** A status a finished Turn can have; `inProgress` is not one. */
function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return value === 'completed' || value === 'interrupted' || value === 'failed'
}

/** A string field the server must have sent. */
function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new Error(
      `codex app-server answered without a string ${field}: ${JSON.stringify(record)}`,
    )
  }
  return value
}

/** A field the server sends as a string or as null, and as nothing else. */
function nullableStringField(record: Record<string, unknown>, field: string): string | null {
  return record[field] === null ? null : stringField(record, field)
}

/** An object field the server must have sent. */
function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field]
  if (!isRecord(value)) {
    throw new Error(
      `codex app-server answered without an object ${field}: ${JSON.stringify(record)}`,
    )
  }
  return value
}

/** The value if it is a plain object, and an empty one otherwise. */
function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** A plain object, not an array and not null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
