import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

/** The one variable that gives a deployment a Cloud Reach: a path to the key file. */
export const CLOUD_KEY_FILE_VAR = 'ROMA_CLOUD_KEY_FILE'

/** Where the exchange happens when the key file does not say. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** What a deployment tells roma about its Cloud Reach. */
export interface CloudEnv {
  /** The identity's own name for itself, out of the key. */
  readonly account: string
  /** The key's private half, PEM, already read off disk. */
  readonly privateKey: string
  /**
   * Where the assertion is exchanged: the key's own `token_uri`, defaulted only
   * for a key that omits it. Enforced by `fence:cloud-exchanges-where-the-key-says`.
   */
  readonly tokenEndpoint: string
}

/**
 * Read the Cloud Reach's key, or find there is none (null).
 *
 * Throws `ConfigurationMissing`, so its problems land in `readConfiguration`'s
 * one refusal.
 *
 * **Absent is not a problem**, and neither is a variable set to the empty
 * string: both are no Cloud Reach. A variable that names a file and does not
 * work — unreadable, empty, not JSON, or not a service account key — refuses.
 * Enforced by `fence:cloud-refuses-only-a-named-path`.
 *
 * The file is read here rather than at first use, so an unreadable key is one
 * of the problems a single boot reports.
 *
 * **Read by the exact path it was given**, and never by asking a library to find
 * a credential. Enforced by `fence:cloud-never-resolves-a-credential`.
 */
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
  // Checked against what minting needs rather than against the whole documented
  // shape: a key missing `project_id` mints perfectly well, and refusing it
  // would be roma inventing a requirement the exchange does not have. What is
  // named in the refusal is the two fields that are load-bearing, so that
  // somebody who pointed this at the wrong JSON is told which file to look for.
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
