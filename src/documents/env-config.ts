import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { reasonOf } from '../operator-log.js'

/**
 * The two variables that give a deployment a Document Reach.
 *
 * A path to a file rather than the key inline, following `ROMA_CLOUD_KEY_FILE`
 * and `ROMA_GITHUB_PRIVATE_KEY_FILE`: multi-line secrets belong in mounts
 * (ADR-0022 §2). Exported so that the refusals below and the README's table
 * cannot come to spell them differently.
 */
export const DOCUMENT_KEY_FILE_VAR = 'ROMA_DOCUMENT_KEY_FILE'
/** The Depot's folder id — a place rather than a boundary (ADR-0022 §2). */
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
   * Where the assertion is exchanged.
   *
   * Read from the key's own `token_uri` rather than hardcoded, for the reason
   * `readCloudEnv` gives: the key is what names it, and a constant would
   * silently ignore a file that said something else. Whoever can write this file
   * can put their own key in it, so a file that could redirect the exchange is
   * already a file that could replace the whole credential — what roma must not
   * do is take an endpoint from anywhere *other* than the key it is signing
   * with, and nothing here does.
   */
  readonly tokenEndpoint: string
  /** The Depot: the one folder roma is told the agent works in. */
  readonly depot: string
}

/**
 * Read the Document Reach's key and its Depot, or find there is neither.
 *
 * Its own reader in its own directory, exactly as the cloud's and the forge's
 * are, and for the same reason: the Core is not allowed to know which product
 * roma mints against. It throws the Core's own `ConfigurationMissing`, so its
 * problems land in the one refusal `readConfiguration` makes rather than in a
 * second one — and **every** problem it can find is a synchronous read, which
 * is better than the Cloud Reach manages (ADR-0015 §8 records that a revoked
 * cloud key costs a second boot, because only its *proof* is a round trip).
 *
 * **Both variables or neither.** A key with no Depot is a credential with
 * nowhere to write; a Depot with no key is a folder nobody can reach. Half of it
 * is a deployment that meant to have a Document Reach, so it refuses here naming
 * the other variable rather than quietly becoming the deployment that has none —
 * which reads as the feature being broken (ADR-0022 §2).
 *
 * **Absent is not a problem.** Most deployments have neither variable and are
 * meant to be untouched by all of this: roma starts, announces nothing about
 * documents, and the Document Shortcut says there is none. The line between
 * absent and broken is drawn at whether a variable was *set*, and it puts one
 * case on the permissive side — a variable set to the empty string, what a shell
 * leaves behind when `ROMA_DOCUMENT_DEPOT=${UNSET}` is substituted, reads as no
 * Document Reach rather than as a mistake. That is `envValue`'s rule for every
 * optional variable roma has. What makes the silent case not silent is the
 * Operator Log: roma states at every boot whether it has a Document Reach and
 * which identity.
 *
 * **Read by the exact path it was given**, and never by asking a library to find
 * a credential. That chain ends at the metadata server, so on the Google hosts
 * roma is designed for a missing key would resolve to roma's *own* identity
 * (ADR-0015 §4, ADR-0022 §1). `src/document-containment.test.ts` is what keeps
 * that true.
 *
 * Neither variable is added to the environment allowlist a Session is spawned
 * with. The key never enters the agent's process environment.
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

  const key = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const account = key['client_email']
  const privateKey = key['private_key']
  // Checked against what minting needs rather than against the whole documented
  // shape, exactly as `readCloudEnv` is: a key missing `project_id` mints
  // perfectly well, and refusing it would be roma inventing a requirement the
  // exchange does not have.
  if (typeof account !== 'string' || account === '' || typeof privateKey !== 'string' || privateKey === '') {
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
