import type {
  ClaudeProcess,
  ClaudeProcessExit,
  SpawnClaudeProcess,
  SpawnRequest,
} from '../../src/claude-process.js'

/**
 * One fake `claude` process. It records what was written to its stdin and lets
 * a test push bytes back out of its stdout — bytes, not events, so that framing
 * is exercised rather than assumed.
 */
export class FakeClaudeProcess implements ClaudeProcess {
  readonly pid: number
  /** Where this process was spawned — how a test tells one Session's from another's. */
  readonly cwd: string
  readonly written: string[] = []
  readonly signals: NodeJS.Signals[] = []
  stdinClosed = false

  readonly #exitOnKill: boolean
  readonly #ignored = new Set<NodeJS.Signals>()
  #exited = false
  #stdout: ((chunk: string) => void)[] = []
  #stderr: ((chunk: string) => void)[] = []
  #exit: ((exit: ClaudeProcessExit) => void)[] = []
  #error: ((error: Error) => void)[] = []

  constructor(pid: number, cwd: string, exitOnKill = false) {
    this.pid = pid
    this.cwd = cwd
    this.#exitOnKill = exitOnKill
  }

  /** Take a signal and do nothing about it, the way a wedged process would. */
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
    // What ADR-0003 measured: SIGTERM exits 143. SIGKILL is not handled by
    // anything, so it surfaces as a signal instead of a code.
    this.emitExit(signal === 'SIGTERM' ? { code: 143, signal: null } : { code: null, signal })
  }

  onStdout(listener: (chunk: string) => void): void {
    this.#stdout.push(listener)
  }

  onStderr(listener: (chunk: string) => void): void {
    this.#stderr.push(listener)
  }

  onExit(listener: (exit: ClaudeProcessExit) => void): void {
    this.#exit.push(listener)
  }

  onError(listener: (error: Error) => void): void {
    this.#error.push(listener)
  }

  /** Everything the Session has sent, parsed back out of its NDJSON frames. */
  get sent(): Record<string, unknown>[] {
    return this.written.flatMap((line) =>
      line
        .split('\n')
        .filter((part) => part.trim() !== '')
        .map((part) => JSON.parse(part) as Record<string, unknown>),
    )
  }

  /** Push raw bytes out of stdout. Split them however you like. */
  emitStdout(chunk: string): void {
    for (const listener of this.#stdout) listener(chunk)
  }

  emitStderr(chunk: string): void {
    for (const listener of this.#stderr) listener(chunk)
  }

  emitExit(exit: ClaudeProcessExit): void {
    this.#exited = true
    for (const listener of this.#exit) listener(exit)
  }

  emitError(error: Error): void {
    for (const listener of this.#error) listener(error)
  }
}

/**
 * Let everything already queued run.
 *
 * A fake process cannot be fed until the thing that spawns it has finished
 * spawning it, and spawning settles on the microtask queue — so a test that
 * drives a Turn has to give way once between asking for it and answering.
 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export interface FakeClaudeOptions {
  /**
   * Whether killing a process makes it exit, the way a real one does.
   *
   * Off by default so a test can drive the signal and the exit separately. On
   * for anything driving the pool: eviction waits for the process to be gone,
   * and a fake that only records the signal would wait forever.
   */
  readonly exitOnKill?: boolean
}

/** A spawner that hands out FakeClaudeProcesses and remembers every request. */
export class FakeClaude {
  readonly spawns: SpawnRequest[] = []
  readonly processes: FakeClaudeProcess[] = []

  readonly #exitOnKill: boolean

  constructor({ exitOnKill = false }: FakeClaudeOptions = {}) {
    this.#exitOnKill = exitOnKill
  }

  readonly spawn: SpawnClaudeProcess = (request) => {
    this.spawns.push(request)
    const proc = new FakeClaudeProcess(4200 + this.processes.length, request.cwd, this.#exitOnKill)
    this.processes.push(proc)
    return proc
  }

  /** The most recent process spawned for one Session, found by its working directory. */
  processFor(cwd: string): FakeClaudeProcess {
    const proc = this.processes.findLast((candidate) => candidate.cwd === cwd)
    if (proc === undefined) throw new Error(`nothing has been spawned in ${cwd}`)
    return proc
  }

  get lastSpawn(): SpawnRequest {
    const spawn = this.spawns.at(-1)
    if (spawn === undefined) throw new Error('nothing has been spawned')
    return spawn
  }

  get process(): FakeClaudeProcess {
    const proc = this.processes.at(-1)
    if (proc === undefined) throw new Error('nothing has been spawned')
    return proc
  }
}
