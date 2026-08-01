import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Credential } from '../../src/build-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Where every throwaway directory seam 2 hands out lives — outside the checkout,
 * on purpose.
 *
 * These used to sit at `${REPO_ROOT}.tmp/seam2/`, which is gitignored but still
 * *inside* the repository, so Claude Code walked up from the working directory
 * and found roma's own `CLAUDE.md` and `.claude/skills/` (#101). That put this
 * project's operating instructions in front of the agent under test and made the
 * baseline depend on whatever skills a contributor happened to have installed.
 *
 * Stable rather than randomised, and per checkout rather than shared. Stable
 * because `liveConfigDir` deliberately survives between runs, so whatever Claude
 * Code writes into it — onboarding state and the like — is not paid for again on
 * every invocation. Per checkout because `.tmp/seam2/` was, and losing that would
 * trade one bug for another: `liveSessionDirs` deletes the directory it is asked
 * for, so two checkouts running seam 2 at once would wipe each other's Session
 * mid-Turn, and on a shared machine a fixed `/tmp` name is somebody else's
 * directory and an `EACCES` that reads like an isolation failure.
 */
const SEAM2_ROOT = join(
  tmpdir(),
  `roma-seam2-${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12)}`,
)

/**
 * The Shared Window credential seam 2 runs on.
 *
 * Fails loudly rather than skipping. A silently skipped seam 2 is worse than no
 * seam 2: it reports green while the one contract the architecture rests on goes
 * unchecked.
 */
export function sharedWindowCredential(): Credential {
  const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? readDotEnv()['CLAUDE_CODE_OAUTH_TOKEN']
  if (token === undefined || token === '') {
    throw new Error(
      'seam 2 needs a Shared Window token. Put CLAUDE_CODE_OAUTH_TOKEN in .env at the ' +
        'repo root (get one with `claude setup-token`), or export it.',
    )
  }
  return { kind: 'shared-window', oauthToken: token }
}

/**
 * A throwaway directory pair for one live Session.
 *
 * The config dir stands in for the container, where no keychain login exists —
 * without it the spawned process resolves credentials against the developer's
 * own machine and the test proves nothing about how roma will run. The working
 * directory closes the other half of the same door: it is outside the repository,
 * so the Session inherits neither roma's `CLAUDE.md` nor its project skills, the
 * way a container running roma would not. `live-claude.test.ts` asserts it.
 */
export function liveSessionDirs(name: string): { configDir: string; cwd: string } {
  const cwd = join(SEAM2_ROOT, 'work', name)
  const configDir = liveConfigDir()
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  return { configDir, cwd }
}

/**
 * A throwaway work root for one live pool.
 *
 * Empty rather than pre-populated: creating the per-Session directory under it
 * is the pool's job, and whether that directory exists is how the pool decides
 * between `--session-id` and `--resume`.
 *
 * Outside the repository for the same reason `liveSessionDirs` is.
 */
export function liveWorkRoot(name: string): { configDir: string; workRoot: string } {
  const workRoot = join(SEAM2_ROOT, 'pool', name)
  const configDir = liveConfigDir()
  rmSync(workRoot, { recursive: true, force: true })
  mkdirSync(workRoot, { recursive: true })
  return { configDir, workRoot }
}

function liveConfigDir(): string {
  const configDir = join(SEAM2_ROOT, 'claude-home')
  mkdirSync(configDir, { recursive: true })
  return configDir
}

function readDotEnv(): Record<string, string> {
  let contents: string
  try {
    contents = readFileSync(`${REPO_ROOT}.env`, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }
  return values
}
