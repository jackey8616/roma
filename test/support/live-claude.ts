import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Credential } from '../../src/build-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

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
 * directory keeps the repo's own CLAUDE.md out of the Session.
 */
export function liveSessionDirs(name: string): { configDir: string; cwd: string } {
  const configDir = `${REPO_ROOT}.tmp/seam2/claude-home`
  const cwd = `${REPO_ROOT}.tmp/seam2/work/${name}`
  mkdirSync(configDir, { recursive: true })
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  return { configDir, cwd }
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
