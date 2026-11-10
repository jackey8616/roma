import { mkdirSync } from 'node:fs'
import type {
  RuntimeProcess,
  RuntimeProcessExit,
  SpawnRuntimeProcess,
  SpawnRequest,
} from '../../src/runtime-process.js'

export class FakeRuntimeProcess implements RuntimeProcess {
  readonly pid: number
  readonly cwd: string
  readonly written: string[] = []
  readonly signals: NodeJS.Signals[] = []
  stdinClosed = false
  readonly started: Promise<boolean>

  readonly #exitOnKill: boolean
  readonly #start: (started: boolean) => void
  readonly #ignored = new Set<NodeJS.Signals>()
  #exited = false
  #stdout: ((chunk: string) => void)[] = []
  #stderr: ((chunk: string) => void)[] = []
  #exit: ((exit: RuntimeProcessExit) => void)[] = []
  #error: ((error: Error) => void)[] = []

  constructor(pid: number, cwd: string, exitOnKill = false, held = false) {
    this.pid = pid
    this.cwd = cwd
    this.#exitOnKill = exitOnKill
    let start: (started: boolean) => void = () => {}
    this.started = new Promise((resolve) => {
      start = resolve
    })
    this.#start = start
    if (!held) start(true)
  }

  emitStarted(started = true): void {
    this.#start(started)
  }

  ignore(signal: NodeJS.Signals): void {
    this.#ignored.add(signal)
  }

  write(line: string): void {
    this.written.push(line)
  }

  closeStdin(): void {
    this.stdinClosed = true
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal)
    if (!this.#exitOnKill || this.#exited || this.#ignored.has(signal)) return
    this.emitExit(signal === 'SIGTERM' ? { code: 143, signal: null } : { code: null, signal })
  }

  onStdout(listener: (chunk: string) => void): void {
    this.#stdout.push(listener)
  }

  onStderr(listener: (chunk: string) => void): void {
    this.#stderr.push(listener)
  }

  onExit(listener: (exit: RuntimeProcessExit) => void): void {
    this.#exit.push(listener)
  }

  onError(listener: (error: Error) => void): void {
    this.#error.push(listener)
  }

  get sent(): Record<string, unknown>[] {
    return this.written.flatMap((line) =>
      line
        .split('\n')
        .filter((part) => part.trim() !== '')
        .map((part) => JSON.parse(part) as Record<string, unknown>),
    )
  }

  emitStdout(chunk: string): void {
    for (const listener of this.#stdout) listener(chunk)
  }

  emitStderr(chunk: string): void {
    for (const listener of this.#stderr) listener(chunk)
  }

  emitExit(exit: RuntimeProcessExit): void {
    this.#exited = true
    this.#start(false)
    for (const listener of this.#exit) listener(exit)
  }

  emitError(error: Error): void {
    for (const listener of this.#error) listener(error)
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export interface FakeRuntimeOptions {
  readonly exitOnKill?: boolean
  readonly holdStart?: boolean
}

export class FakeRuntime {
  readonly spawns: SpawnRequest[] = []
  readonly processes: FakeRuntimeProcess[] = []

  readonly #exitOnKill: boolean
  readonly #holdStart: boolean

  constructor({ exitOnKill = false, holdStart = false }: FakeRuntimeOptions = {}) {
    this.#exitOnKill = exitOnKill
    this.#holdStart = holdStart
  }

  readonly spawn: SpawnRuntimeProcess = (request) => {
    this.spawns.push(request)
    if (request.seat !== undefined) mkdirSync(request.cwd, { recursive: true })
    const proc = new FakeRuntimeProcess(
      4200 + this.processes.length,
      request.cwd,
      this.#exitOnKill,
      this.#holdStart,
    )
    this.processes.push(proc)
    return proc
  }

  processFor(cwd: string): FakeRuntimeProcess {
    const proc = this.processes.findLast((candidate) => candidate.cwd === cwd)
    if (proc === undefined) throw new Error(`nothing has been spawned in ${cwd}`)
    return proc
  }

  get lastSpawn(): SpawnRequest {
    const spawn = this.spawns.at(-1)
    if (spawn === undefined) throw new Error('nothing has been spawned')
    return spawn
  }

  get process(): FakeRuntimeProcess {
    const proc = this.processes.at(-1)
    if (proc === undefined) throw new Error('nothing has been spawned')
    return proc
  }
}
