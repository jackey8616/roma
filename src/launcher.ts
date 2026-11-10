import { spawn } from 'node:child_process'
import { chmodSync, chownSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LAUNCHER, seatName, spawnThrough, type SpawnRuntimeProcess } from './runtime-process.js'

export const ROOTS_FILE = '/run/roma-launch/roots'

export interface LauncherRoots {
  readonly work: string
  readonly config: string
  readonly shim: string
}

export interface SessionLauncher {
  enclose(seat: number, sessionId: string, name: string, content: Uint8Array): Promise<void>
  reclaim(sessionId: string): Promise<void>
}

export interface Launcher extends SessionLauncher {
  readonly spawn: SpawnRuntimeProcess
  writeRoots(roots: LauncherRoots): void
  sweep(): Promise<void>
  handOutSockets(): Promise<void>
}

export class LauncherFailed extends Error {
  readonly mode: string
  readonly code: number | null

  constructor(mode: string, code: number | null, stderr: string) {
    super(
      `roma-launch ${mode} failed (${code === null ? 'killed' : `exit ${code}`})` +
        (stderr.trim() === '' ? '' : `: ${stderr.trim()}`),
    )
    this.name = 'LauncherFailed'
    this.mode = mode
    this.code = code
  }
}

export class IsolationRefused extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      [
        'roma refused to start — it could not keep one Session out of another’s reach (ADR-0036).',
        ...problems.map((problem) => `  - ${problem}`),
      ].join('\n'),
    )
    this.name = 'IsolationRefused'
    this.problems = problems
  }
}

export async function isolating(what: string, step: () => Promise<void>): Promise<void> {
  try {
    await step()
  } catch (error) {
    throw new IsolationRefused([
      `roma-launch could not ${what}: ${error instanceof Error ? error.message : String(error)}`,
    ])
  }
}

export function realLauncher(path: string = LAUNCHER, rootsFile: string = ROOTS_FILE): Launcher {
  const call = (args: readonly string[], input?: Uint8Array): Promise<void> =>
    new Promise((done, failed) => {
      const child = spawn(path, [...args], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', (error) => failed(new LauncherFailed(args[0] ?? '', null, error.message)))
      child.on('close', (code) => {
        if (code === 0) done()
        else failed(new LauncherFailed(args[0] ?? '', code, stderr))
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })

  return {
    spawn: spawnThrough(path),
    writeRoots: (roots) => writeRootsFile(roots, rootsFile),
    sweep: () => call(['sweep']),
    handOutSockets: () => call(['seats']),
    enclose: (seat, sessionId, name, content) =>
      call(['enclose', seatName(seat), sessionId, name], content),
    reclaim: (sessionId) => call(['reclaim', sessionId]),
  }
}

export function writeRootsFile({ work, config, shim }: LauncherRoots, file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o755 })
  const pending = `${file}.pending`
  writeFileSync(pending, `work ${work}\nconfig ${config}\nshim ${shim}\n`, { mode: 0o644 })
  chownSync(pending, 0, 0)
  chmodSync(pending, 0o644)
  renameSync(pending, file)
}
