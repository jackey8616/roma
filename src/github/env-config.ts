import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, required, type Environment } from '../env-config.js'

export interface MinterEnv {
  readonly appId: string
  /** The App's private key as PEM text, already read off disk. */
  readonly privateKey: string
}

/**
 * Read the GitHub App's settings, reading the private key file now. Throws the
 * Core's `ConfigurationMissing` naming every problem, an unreadable or empty key
 * file among them, so they land in the one refusal `readConfiguration` makes.
 */
export function readMinterEnv(env: Environment): MinterEnv {
  const problems: string[] = []

  const appId = required(env, 'ROMA_GITHUB_APP_ID', problems)
  const keyFile = required(env, 'ROMA_GITHUB_PRIVATE_KEY_FILE', problems)

  let privateKey: string | null = null
  if (keyFile !== null) {
    try {
      privateKey = readFileSync(keyFile, 'utf8')
    } catch (error) {
      problems.push(
        `ROMA_GITHUB_PRIVATE_KEY_FILE is "${keyFile}", which roma could not read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (privateKey !== null && privateKey.trim() === '') {
    problems.push(`ROMA_GITHUB_PRIVATE_KEY_FILE is "${String(keyFile)}", and that file is empty.`)
    privateKey = null
  }

  if (problems.length > 0) throw new ConfigurationMissing(problems)
  // Both are non-null here: every path that leaves one null pushed a problem,
  // and a problem is what the line above refuses on.
  return { appId: appId ?? '', privateKey: privateKey ?? '' }
}

/**
 * Where the real `gh` is, for the Shim that stands in front of it. Defaults to
 * where the image puts it, off `PATH`; `ROMA_GH_BIN` overrides it for roma run
 * from source and for tests that drive the Shim against a stub.
 */
export function realGhPath(env: Environment = process.env): string {
  return envValue(env, 'ROMA_GH_BIN') ?? '/usr/local/lib/roma/gh'
}
