import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

/**
 * The one variable that gives a deployment a Cloud Reach.
 *
 * A path to a file rather than the key inline, following
 * `ROMA_GITHUB_PRIVATE_KEY_FILE` and `GOOGLE_APPLICATION_CREDENTIALS`:
 * multi-line secrets belong in mounts (ADR-0015 §3). Exported so that the
 * refusals below and the README's table cannot come to spell it differently.
 */
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
   * Where the assertion is exchanged.
   *
   * Read from the key's own `token_uri` rather than hardcoded, because the key
   * is what names it and a constant would silently ignore a file that said
   * something else — which is the failure mode for any deployment Google ever
   * moves, and for anybody signing against a non-public endpoint. The default
   * below is only for a key that omits the field.
   *
   * It is not a widening: whoever can write this file can put their own key in
   * it, so a file that could redirect the exchange is already a file that could
   * replace the whole credential. What roma must not do is accept an endpoint
   * from anywhere *other* than the key it is signing with, and nothing here
   * takes one.
   */
  readonly tokenEndpoint: string
}

/**
 * Read the Cloud Reach's key, or find there is none.
 *
 * Its own reader in its own directory, exactly as the forge's is, and for the
 * same reason: the Core is not allowed to know which cloud roma mints against.
 * It throws the Core's own `ConfigurationMissing`, so its problems land in the
 * one refusal `readConfiguration` makes rather than in a second one.
 *
 * **Absent is not a problem.** Most deployments have no Cloud Reach and are
 * meant to be untouched by this — roma starts, announces nothing about the
 * cloud, and the Cloud Shortcut says there is none (ADR-0015 §9). What *is* a
 * problem is a variable that names a file and does not work: unreadable, empty,
 * not JSON, or JSON that is not a service account key. A deployment that meant
 * to give roma a Cloud Reach and mistyped the path must not silently get the
 * no-Cloud-Reach behaviour, because that reads as the feature being broken.
 *
 * The line between the two is drawn at whether a *path* was named, and it puts
 * one case on the permissive side: a variable set to the empty string — what a
 * shell leaves behind when `ROMA_CLOUD_KEY_FILE=${UNSET}` is substituted — reads
 * as no Cloud Reach rather than as a mistake. That is `envValue`'s rule for
 * every optional variable roma has, `ROMA_OVERFLOW_API_KEY` included, and
 * departing from it here would mean refusing to boot for a deployment that
 * deliberately blanked the variable to turn the feature off. What makes the
 * silent case not silent is the Operator Log: roma states at every boot whether
 * it has a Cloud Reach and which identity, so "I meant to configure one" is
 * answerable from the first line of the log rather than from a Task that fails
 * later.
 *
 * The file is read here rather than at first use, for `readMinterEnv`'s stated
 * reason: an unreadable key is one of the problems a single boot reports rather
 * than a failure inside somebody's first Turn.
 *
 * **Read by the exact path it was given**, and never by asking a library to find
 * a credential. That chain ends at the metadata server, so on the Google hosts
 * roma is designed for a missing key would resolve to roma's *own* identity —
 * the one identity a Cloud Reach must never be (ADR-0015 §4).
 * `src/cloud-containment.test.ts` is what keeps that true.
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
