import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { codexHomeProblems, readCodexHome } from '../../src/codex-home.js'
import { readDotEnv, SEAM2_ROOT } from './live-claude.js'

/** The model the live tests insist on — ADR-0026's one pin. */
export const PINNED_CODEX_MODEL = 'gpt-5.6-sol'

/**
 * The operator-seeded `CODEX_HOME` the Codex live tests run on, read the way a
 * deployment's is, from the environment over `.env`.
 *
 * Fails loudly rather than skipping, on `sharedWindowCredential`'s argument: a
 * live run that skipped itself would report green about a credential nobody
 * checked.
 */
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

/** The build under test, read off the binary rather than assumed from the Dockerfile. */
export function codexVersion(): string {
  return execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()
}

/**
 * A throwaway working directory, under seam 2's per-checkout root for its
 * reasons, and outside the checkout so Codex's walk up for `AGENTS.md` finds
 * none of roma's own instructions. `live-codex.test.ts` asserts it.
 */
export function liveCodexCwd(name: string): string {
  const cwd = join(SEAM2_ROOT, 'codex-work', name)
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  return cwd
}
