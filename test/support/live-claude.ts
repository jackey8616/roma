import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Credential } from '../../src/build-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const SEAM2_ROOT = join(
  tmpdir(),
  `roma-seam2-${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12)}`,
)

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

export function liveSessionDirs(name: string): { configDir: string; cwd: string } {
  const cwd = join(SEAM2_ROOT, 'work', name)
  const configDir = liveConfigDir()
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  return { configDir, cwd }
}

export function liveWorkRoot(name: string): { configDir: string; workRoot: string } {
  const workRoot = join(SEAM2_ROOT, 'pool', name)
  const configDir = liveConfigDir()
  rmSync(workRoot, { recursive: true, force: true })
  mkdirSync(workRoot, { recursive: true })
  return { configDir, workRoot }
}

export function liveCaptureFile(name: string): string {
  const dir = join(SEAM2_ROOT, 'capture')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.jsonl`)
  rmSync(file, { force: true })
  return file
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
