import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

export const DOCUMENT_KEY_FILE_VAR = 'ROMA_DOCUMENT_KEY_FILE'
export const DOCUMENT_DEPOT_VAR = 'ROMA_DOCUMENT_DEPOT'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface DocumentEnv {
  readonly account: string
  readonly privateKey: string
  readonly tokenEndpoint: string
  readonly depot: string
}

export function readDocumentEnv(env: Environment): DocumentEnv | null {
  const keyFile = envValue(env, DOCUMENT_KEY_FILE_VAR)
  const depot = envValue(env, DOCUMENT_DEPOT_VAR)
  if (keyFile === null && depot === null) return null
  if (keyFile === null) {
    throw new ConfigurationMissing([
      `${DOCUMENT_DEPOT_VAR} is "${String(depot)}" and ${DOCUMENT_KEY_FILE_VAR} is not set — a ` +
        'Depot with no key behind it is a folder nobody can reach. Set both, or neither.',
    ])
  }
  if (depot === null) {
    throw new ConfigurationMissing([
      `${DOCUMENT_KEY_FILE_VAR} is "${keyFile}" and ${DOCUMENT_DEPOT_VAR} is not set — a key with ` +
        'no Depot is a credential with nowhere to write. Set both, or neither.',
    ])
  }

  let contents: string
  try {
    contents = readFileSync(keyFile, 'utf8')
  } catch (error) {
    throw new ConfigurationMissing([
      `${DOCUMENT_KEY_FILE_VAR} is "${keyFile}", which roma could not read: ${reasonOf(error)}`,
    ])
  }
  if (contents.trim() === '') {
    throw new ConfigurationMissing([
      `${DOCUMENT_KEY_FILE_VAR} is "${keyFile}", and that file is empty.`,
    ])
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new ConfigurationMissing([
      `${DOCUMENT_KEY_FILE_VAR} is "${keyFile}", which is not JSON. It should be a service ` +
        'account key file, as the JSON Google hands back when a key is created for one.',
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
      `${DOCUMENT_KEY_FILE_VAR} is "${keyFile}", which is JSON but not a service account key — ` +
        'roma found no `client_email` and `private_key` in it.',
    ])
  }

  const tokenUri = key['token_uri']
  return {
    account,
    privateKey,
    tokenEndpoint: typeof tokenUri === 'string' && tokenUri !== '' ? tokenUri : TOKEN_ENDPOINT,
    depot,
  }
}
