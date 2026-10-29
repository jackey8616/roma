import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { envValue, type Environment } from './env-config.js'

/**
 * The `CODEX_HOME` a deployment named, or null where it configured no Codex —
 * optional and never defaulted (ADR-0025, ADR-0026 *The home*).
 *
 * Absolute, because the process that reads it starts in a different directory
 * from the one roma was started in, and a relative home would name two places.
 */
export function readCodexHome(env: Environment, problems: string[]): string | null {
  const found = envValue(env, 'ROMA_CODEX_HOME')
  if (found === null) return null
  if (!isAbsolute(found)) {
    problems.push(`ROMA_CODEX_HOME is "${found}", which is not an absolute path.`)
    return null
  }
  return found
}

/**
 * What is wrong with a `CODEX_HOME`, as sentences an operator can act on — empty
 * where nothing is.
 *
 * It must be a writable directory holding a seeded `auth.json` (ADR-0026 *The
 * home*). The file's contents are not read: the credential is the Runtime's to
 * interpret.
 */
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
  } catch {
    // Absent, which is the sentence below.
  }
  if (!seeded) {
    problems.push(
      `${auth} does not exist. Seed it by logging in straight into this directory — ` +
        `\`CODEX_HOME=${codexHome} codex login\` — never by copying an auth.json from elsewhere.`,
    )
  }
  return problems
}
