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
  readonly written: string[] = []
  readonly signals: NodeJS.Signals[] = []
  stdinClosed = false

  #stdout: ((chunk: string) => void)[] = []
  #stderr: ((chunk: string) => void)[] = []
  #exit: ((exit: ClaudeProcessExit) => void)[] = []
  #error: ((error: Error) => void)[] = []

  constructor(pid: number) {
    this.pid = pid
  }

  write(line: string): void {
    this.written.push(line)
  }

  closeStdin(): void {
    this.stdinClosed = true
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal)
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
    for (const listener of this.#exit) listener(exit)
  }

  emitError(error: Error): void {
    for (const listener of this.#error) listener(error)
  }
}

/** A spawner that hands out FakeClaudeProcesses and remembers every request. */
export class FakeClaude {
  readonly spawns: SpawnRequest[] = []
  readonly processes: FakeClaudeProcess[] = []

  readonly spawn: SpawnClaudeProcess = (request) => {
    this.spawns.push(request)
    const proc = new FakeClaudeProcess(4200 + this.processes.length)
    this.processes.push(proc)
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
