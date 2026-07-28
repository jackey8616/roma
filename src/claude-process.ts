import { spawn } from 'node:child_process'

export interface ClaudeProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface SpawnRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * The whole of the operating system as far as ClaudeSession is concerned:
 * a process it writes lines to and reads lines from.
 *
 * Deliberately narrower than a Node ChildProcess. It is the seam a test
 * substitutes at, and every stream detail it hides — encodings, nullable stdio,
 * backpressure — is a detail a fake would otherwise have to imitate correctly to
 * be worth anything.
 */
export interface ClaudeProcess {
  readonly pid: number | undefined
  write(line: string): void
  closeStdin(): void
  kill(signal: NodeJS.Signals): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  onExit(listener: (exit: ClaudeProcessExit) => void): void
  onError(listener: (error: Error) => void): void
}

export type SpawnClaudeProcess = (request: SpawnRequest) => ClaudeProcess

/** Spawn a real `claude` process. */
export const spawnClaudeProcess: SpawnClaudeProcess = ({ command, args, cwd, env }) => {
  const child = spawn(command, [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const { stdin, stdout, stderr } = child
  if (stdin === null || stdout === null || stderr === null) {
    throw new Error(`${command} spawned without piped stdio`)
  }

  stdout.setEncoding('utf8')
  stderr.setEncoding('utf8')

  return {
    get pid() {
      return child.pid
    },
    write: (line) => {
      stdin.write(line)
    },
    closeStdin: () => {
      stdin.end()
    },
    kill: (signal) => {
      child.kill(signal)
    },
    onStdout: (listener) => {
      stdout.on('data', (chunk: string) => listener(chunk))
    },
    onStderr: (listener) => {
      stderr.on('data', (chunk: string) => listener(chunk))
    },
    onExit: (listener) => {
      child.on('exit', (code, signal) => listener({ code, signal }))
    },
    onError: (listener) => {
      child.on('error', listener)
    },
  }
}
