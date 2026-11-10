import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { codexHomeProblems, readCodexHome } from '../../src/codex-home.js'
import { readDotEnv, SEAM2_ROOT } from './live-claude.js'

export const PINNED_CODEX_MODEL = 'gpt-5.6-sol'

export function seededCodexHome(): string {
  const unreadable: string[] = []
  const codexHome = readCodexHome({ ...readDotEnv(), ...process.env }, unreadable)
  if (codexHome === null) {
    throw new Error(
      unreadable[0] ??
        'the Codex live tests need a seeded CODEX_HOME. Log in with ' +
          '`CODEX_HOME=<dir> codex login` and put ROMA_CODEX_HOME=<dir> in .env at the repo root.',
    )
  }
  const problems = codexHomeProblems(codexHome)
  if (problems.length > 0) throw new Error(problems.join('\n'))
  return codexHome
}

export function codexVersion(): string {
  return execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
}

export function liveCodexCwd(name: string): string {
  const cwd = join(SEAM2_ROOT, 'codex-work', name)
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  return cwd
}
