import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'

export const LAUNCHER = '/usr/local/libexec/roma-launch'

export interface SeatLease {
  readonly seat: number
  readonly sessionId: string
}

export type SeatOutcome =
  { readonly returned: true } | { readonly returned: false; readonly reason: string }

export interface ClaudeProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly seat?: SeatOutcome
}

export interface SpawnRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly seat?: SeatLease
}

export interface ClaudeProcess {
  readonly pid: number | undefined
  readonly started: Promise<boolean>
  write(line: string): void
  closeStdin(): void
  kill(signal: NodeJS.Signals): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  onExit(listener: (exit: ClaudeProcessExit) => void): void
  onError(listener: (error: Error) => void): void
}

export type SpawnClaudeProcess = (request: SpawnRequest) => ClaudeProcess

export function seatName(seat: number): string {
  return String(seat).padStart(2, '0')
}

export function seatOutcomeOf(report: string, seat: number): SeatOutcome {
  const lines = report.split('\n').filter((line) => line !== '')
  if (lines.includes(`returned seat ${seatName(seat)}`)) return { returned: true }
  const said = lines.filter((line) => !line.startsWith('started ')).join('; ')
  return {
    returned: false,
    reason: said === '' ? 'the Launcher ended without saying the Seat was returned' : said,
  }
}

export function launcherArgs(
  launcher: string,
  { command, args, seat }: SpawnRequest,
): { readonly command: string; readonly args: readonly string[] } {
  if (seat === undefined) return { command, args }
  return {
    command: launcher,
    args: ['run', seatName(seat.seat), seat.sessionId, '--', command, ...args],
  }
}

export function spawnThrough(launcher: string): SpawnClaudeProcess {
  return (request) => {
    const { command, args } = launcherArgs(launcher, request)
    const seated = request.seat !== undefined
    const child = spawn(command, [...args], {
      cwd: seated ? '/' : request.cwd,
      env: request.env,
      stdio: seated ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    })
    const report = reportOf(child, request.seat)
    return wrap(child, command, report?.outcome ?? null, report?.started ?? spawned(child))
  }
}

function spawned(child: ChildProcess): Promise<boolean> {
  return new Promise((done) => {
    child.once('spawn', () => done(true))
    child.once('error', () => done(false))
  })
}

export const spawnClaudeProcess: SpawnClaudeProcess = spawnThrough(LAUNCHER)

function reportOf(
  child: ChildProcess,
  seat: SeatLease | undefined,
): { readonly outcome: Promise<SeatOutcome>; readonly started: Promise<boolean> } | null {
  if (seat === undefined) return null
  const report = child.stdio[3] as Readable | null | undefined
  if (report == null) {
    return {
      outcome: Promise.resolve({
        returned: false,
        reason: 'the Launcher was given no report pipe',
      }),
      started: Promise.resolve(false),
    }
  }
  report.setEncoding('utf8')
  let text = ''
  let start: (started: boolean) => void = () => {}
  const started = new Promise<boolean>((done) => {
    start = done
  })
  report.on('data', (chunk: string) => {
    text += chunk
    if (text.split('\n').some((line) => line.startsWith('started '))) start(true)
  })
  const outcome = new Promise<SeatOutcome>((done) => {
    const ended = (): void => {
      start(false)
      done(seatOutcomeOf(text, seat.seat))
    }
    report.on('close', ended)
    report.on('error', ended)
  })
  return { outcome, started }
}

function wrap(
  child: ChildProcess,
  command: string,
  seat: Promise<SeatOutcome> | null,
  started: Promise<boolean>,
): ClaudeProcess {
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
    started,
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
      child.on('exit', (code, signal) => {
        if (seat === null) {
          listener({ code, signal })
          return
        }
        void seat.then((outcome) => listener({ code, signal, seat: outcome }))
      })
    },
    onError: (listener) => {
      child.on('error', listener)
    },
  }
}
