import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

/** The key-file half of the two variables that give a deployment a Document Reach. */
export const DOCUMENT_KEY_FILE_VAR = 'ROMA_DOCUMENT_KEY_FILE'
/** The Depot's folder id. */
export const DOCUMENT_DEPOT_VAR = 'ROMA_DOCUMENT_DEPOT'

/** Where the exchange happens when the key file does not say. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** What a deployment tells roma about its Document Reach. */
export interface DocumentEnv {
  /** The identity's own name for itself, out of the key. */
  readonly account: string
  /** The key's private half, PEM, already read off disk. */
  readonly privateKey: string
  /**
   * Where the assertion is exchanged: the key's own `token_uri`, defaulted only
   * for a key that omits it. Enforced by `fence:documents-exchanges-where-the-key-says`.
   */
  readonly tokenEndpoint: string
  /** The Depot: the one folder roma is told the agent works in. */
  readonly depot: string
}

/**
 * Read the Document Reach's key and its Depot, or find there is neither (null).
 *
 * Throws `ConfigurationMissing`, so its problems land in `readConfiguration`'s
 * one refusal; every one of them is found synchronously, at boot.
 *
 * **Both variables or neither.** Half of it refuses, naming the other variable.
 * Enforced by `fence:documents-both-variables-or-neither`.
 *
 * **Absent is not a problem**, and neither is a variable set to the empty
 * string: both are no Document Reach. A key file that is unreadable, empty, not
 * JSON, or not a service account key refuses.
 *
 * **Read by the exact path it was given**, and never by asking a library to find
 * a credential. Enforced by `fence:documents-never-resolves-a-credential`.
 *
 * The key never enters a Session's process environment.
 */
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
  // Checked against what minting needs rather than against the whole documented
  // shape, exactly as `readCloudEnv` is: a key missing `project_id` mints
  // perfectly well, and refusing it would be roma inventing a requirement the
  // exchange does not have.
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
