import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { envValue, type Environment } from './env-config.js'

export function readCodexHome(env: Environment, problems: string[]): string | null {
  const found = envValue(env, 'ROMA_CODEX_HOME')
  if (found === null) return null
  if (!isAbsolute(found)) {
    problems.push(`ROMA_CODEX_HOME is "${found}", which is not an absolute path.`)
    return null
  }
  return found
}

export function codexHomeProblems(codexHome: string): string[] {
  let isDirectory: boolean
  try {
    isDirectory = statSync(codexHome).isDirectory()
  } catch {
    return [`ROMA_CODEX_HOME is ${codexHome}, which does not exist.`]
  }
  if (!isDirectory) return [`ROMA_CODEX_HOME is ${codexHome}, which is not a directory.`]

  const problems: string[] = []
  try {
    accessSync(codexHome, constants.W_OK)
  } catch {
    problems.push(
      `ROMA_CODEX_HOME is ${codexHome}, which roma cannot write to. It must be writable: ` +
        'Codex rewrites auth.json every time it refreshes the login.',
    )
  }

  const auth = join(codexHome, 'auth.json')
  let seeded = false
  try {
    seeded = statSync(auth).isFile()
  } catch {}
  if (!seeded) {
    problems.push(
      `${auth} does not exist. Seed it by logging in straight into this directory — ` +
        `\`CODEX_HOME=${codexHome} codex login\` — never by copying an auth.json from elsewhere.`,
    )
  }
  return problems
}
