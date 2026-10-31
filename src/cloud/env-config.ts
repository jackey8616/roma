import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

export const CLOUD_KEY_FILE_VAR = 'ROMA_CLOUD_KEY_FILE'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface CloudEnv {
  readonly account: string
  readonly privateKey: string
  readonly tokenEndpoint: string
}

export function readCloudEnv(env: Environment): CloudEnv | null {
  const keyFile = envValue(env, CLOUD_KEY_FILE_VAR)
  if (keyFile === null) return null

  let contents: string
  try {
    contents = readFileSync(keyFile, 'utf8')
  } catch (error) {
    throw new ConfigurationMissing([
      `${CLOUD_KEY_FILE_VAR} is "${keyFile}", which roma could not read: ${reasonOf(error)}`,
    ])
  }
  if (contents.trim() === '') {
    throw new ConfigurationMissing([
      `${CLOUD_KEY_FILE_VAR} is "${keyFile}", and that file is empty.`,
    ])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new ConfigurationMissing([
      `${CLOUD_KEY_FILE_VAR} is "${keyFile}", which is not JSON. It should be a service ` +
        'account key file, as `gcloud iam service-accounts keys create` writes one.',
    ])
  }

  const key =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const account = key['client_email']
  const privateKey = key['private_key']
  if (
    typeof account !== 'string' ||
    account === '' ||
    typeof privateKey !== 'string' ||
    privateKey === ''
  ) {
    throw new ConfigurationMissing([
      `${CLOUD_KEY_FILE_VAR} is "${keyFile}", which is JSON but not a service account key — ` +
        'roma found no `client_email` and `private_key` in it.',
    ])
  }

  const tokenUri = key['token_uri']
  return {
    account,
    privateKey,
    tokenEndpoint: typeof tokenUri === 'string' && tokenUri !== '' ? tokenUri : TOKEN_ENDPOINT,
  }
}
