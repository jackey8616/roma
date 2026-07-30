import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, required, type Environment } from '../env-config.js'

/** What a deployment tells roma about its GitHub App. */
export interface MinterEnv {
  readonly appId: string
  /** The App's private key, PEM, already read off disk. */
  readonly privateKey: string
}

/**
 * Read the GitHub App's settings, and refuse with everything that is wrong.
 *
 * Its own reader in its own directory, exactly as a Channel's is, and for the
 * same reason: the Core is not allowed to know which forge roma mints against
 * any more than it is allowed to know which product a message came from. It
 * throws the Core's own `ConfigurationMissing`, so its problems land in the one
 * refusal `readConfiguration` makes rather than in a second one.
 *
 * **Not the Overflow shape** — optional, but refused if half-configured. roma
 * without GitHub is not a roma anybody wants running: the image installs `git`
 * on the grounds that it is what the agent is for, and an agent that cannot
 * clone cannot do the middle of what people will ask for.
 *
 * A file path rather than an inline PEM, following `GOOGLE_APPLICATION_CREDENTIALS`:
 * multi-line secrets belong in mounts. The file is read here rather than at
 * first use, so that an unreadable key is one of the problems a single boot
 * reports rather than a failure inside somebody's first Turn.
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
 * Where the real `gh` is, for the Shim that stands in front of it.
 *
 * Read from the environment with a default, rather than required, because the
 * image is where the answer normally comes from — it puts the real binary
 * somewhere that is not on `PATH` and the Shim under the name `gh`. The override
 * exists for a developer running roma from source, and for the test that drives
 * the Shim against a stub.
 */
export function realGhPath(env: Environment = process.env): string {
  return envValue(env, 'ROMA_GH_BIN') ?? '/usr/local/lib/roma/gh'
}
