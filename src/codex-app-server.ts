import type { RuntimeProcess, SpawnRuntimeProcess } from './runtime-process.js'
import { spawnRuntimeProcess } from './runtime-process.js'

export class CodexAppServer {
  readonly #process: RuntimeProcess
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
    spawn = spawnRuntimeProcess,
  }: CodexAppServerOptions) {
    this.#process = spawn({
      command: 'codex',
      args: ['app-server'],
      cwd,
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

  get stderr(): readonly string[] {
    return this.#stderr
  }

  async initialize(clientVersion: string): Promise<CodexInitialized> {
    const result = await this.#request('initialize', {
      clientInfo: { name: 'roma', title: null, version: clientVersion },
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    this.#send({ method: 'initialized' })
    return {
      userAgent: stringField(result, 'userAgent'),
      codexHome: stringField(result, 'codexHome'),
    }
  }

  async startThread({ model, cwd }: CodexThreadRequest): Promise<CodexThread> {
    const result = await this.#request('thread/start', { model, cwd, approvalPolicy: 'never' })
    return {
      threadId: stringField(objectField(result, 'thread'), 'id'),
      model: stringField(result, 'model'),
      reasoningEffort: nullableStringField(result, 'reasoningEffort'),
    }
  }

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

  async close(graceMs = 5_000): Promise<void> {
    if (this.#lostBecause !== null) return
    this.#process.closeStdin()
    const timer = setTimeout(() => this.#process.kill('SIGKILL'), graceMs)
    await this.#exit
    clearTimeout(timer)
  }

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

  #send(message: Record<string, unknown>): void {
    this.#process.write(`${JSON.stringify(message)}\n`)
  }

  #read(chunk: string): void {
    this.#buffered += chunk
    const lines = this.#buffered.split('\n')
    this.#buffered = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') this.#dispatch(line)
  }

  #dispatch(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
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
      this.#keepStderr(`<unroutable on stdout> ${line.slice(0, 200)}`)
    }
  }

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

  #decline(id: unknown, method: string): void {
    this.#send({
      id,
      error: { code: -32601, message: `roma does not answer ${method} from this harness` },
    })
  }

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

  #lose(reason: string): void {
    if (this.#lostBecause !== null) return
    this.#lostBecause = reason
    const lost = new CodexAppServerLost(reason, this.#stderr)
    for (const { reply } of this.#pending.values()) reply.reject(lost)
    this.#pending.clear()
    this.#turn?.completed.reject(lost)
  }

  #keepStderr(chunk: string): void {
    this.#stderr.push(...chunk.split('\n').filter((line) => line !== ''))
    if (this.#stderr.length > STDERR_LINES) {
      this.#stderr.splice(0, this.#stderr.length - STDERR_LINES)
    }
  }
}

export interface CodexAppServerOptions {
  readonly codexHome: string
  readonly cwd: string
  readonly inherit?: Readonly<Record<string, string>>
  readonly spawn?: SpawnRuntimeProcess
}

export interface CodexInitialized {
  readonly userAgent: string
  readonly codexHome: string
}

export interface CodexThreadRequest {
  readonly model: string
  readonly cwd: string
}

export interface CodexThread {
  readonly threadId: string
  readonly model: string
  readonly reasoningEffort: string | null
}

export interface CodexTurnRequest {
  readonly threadId: string
  readonly text: string
  readonly effort?: string
}

export interface CodexTurn {
  readonly turnId: string
  readonly status: CodexTurnStatus
  readonly text: string
  readonly error: string | null
  readonly tokenUsage: CodexTokenUsage | null
}

export type CodexTurnStatus = (typeof TURN_STATUSES)[number]

const TURN_STATUSES = ['completed', 'interrupted', 'failed'] as const

export interface CodexTokenUsage {
  readonly total: CodexTokenBreakdown
  readonly last: CodexTokenBreakdown
}

export interface CodexTokenBreakdown {
  readonly totalTokens: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteInputTokens: number
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
}

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

export class CodexAppServerLost extends Error {
  readonly stderr: readonly string[]

  constructor(reason: string, stderr: readonly string[]) {
    super(stderr.length === 0 ? reason : `${reason}\n${stderr.slice(-STDERR_TAIL).join('\n')}`)
    this.name = 'CodexAppServerLost'
    this.stderr = [...stderr]
  }
}

const STDERR_LINES = 200
const STDERR_TAIL = 20

interface Pending {
  readonly method: string
  readonly reply: Deferred<Record<string, unknown>>
}

interface RunningTurn {
  readonly threadId: string
  readonly messages: string[]
  tokenUsage: CodexTokenUsage | null
  usageProblem: string | null
  readonly completed: Deferred<CodexTurn>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function readTokenUsage(value: unknown): CodexTokenUsage | null {
  if (!isRecord(value)) return null
  const total = readBreakdown(value['total'])
  const last = readBreakdown(value['last'])
  return total === null || last === null ? null : { total, last }
}

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

function isTurnStatus(value: unknown): value is CodexTurnStatus {
  return TURN_STATUSES.some((status) => status === value)
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new Error(
      `codex app-server answered without a string ${field}: ${JSON.stringify(record)}`,
    )
  }
  return value
}

function nullableStringField(record: Record<string, unknown>, field: string): string | null {
  return record[field] === null ? null : stringField(record, field)
}

function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field]
  if (!isRecord(value)) {
    throw new Error(
      `codex app-server answered without an object ${field}: ${JSON.stringify(record)}`,
    )
  }
  return value
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
