import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, required, type Environment } from '../env-config.js'

export interface MinterEnv {
  readonly appId: string
  readonly privateKey: string
}

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
  return { appId: appId ?? '', privateKey: privateKey ?? '' }
}

export function realGhPath(env: Environment = process.env): string {
  return envValue(env, 'ROMA_GH_BIN') ?? '/usr/local/lib/roma/gh'
}
