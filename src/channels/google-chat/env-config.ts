import {
  ConfigurationMissing,
  certain,
  required,
  wholeNumber,
  type Environment,
} from '../../env-config.js'

/**
 * How many messages roma will hold a lease on at once.
 *
 * Generous rather than tight, and the reason is `/stop`. A Command is answered
 * outside the Task Queue precisely so that it never waits behind the Task it was
 * sent to stop — but a message Pub/Sub is holding back has not reached the Core
 * to be recognised as a Command at all, so flow control set near the concurrency
 * cap would reinstate the very wait the Core is careful to avoid. Twenty is well
 * above anything one team produces at once, and the Task Queue is what actually
 * limits how much runs.
 */
export const DEFAULT_MAX_MESSAGES = 20

/**
 * How long the client library keeps extending a message's acknowledgement
 * deadline before giving up on it.
 *
 * An hour, which covers a Turn comfortably and a parked Task sometimes not: a
 * Task waiting out a spent Shared Window waits until the provider's own reset
 * time, and that can be hours away. Past this the message is delivered again —
 * harmlessly while the original is still in flight, since the subscriber drops a
 * redelivery of work it is already doing, but as a genuine second run if the
 * first has finished by then.
 *
 * Raising it does not make that impossible, only rarer, and Pub/Sub's own
 * ceiling is a day. It is set here rather than left to the library's default so
 * that the number is somewhere an operator can find it after being answered
 * twice.
 */
export const DEFAULT_MAX_LEASE_MINUTES = 60

/**
 * What Google Chat needs to know to reach the queue Chat publishes to.
 *
 * Everything here is read; nothing is created. The topic, the subscription, the
 * service account and the grant that lets Chat publish are provisioning, which
 * is out of scope for roma by decision rather than by omission — a program that
 * created its own subscription would be a program that could silently create the
 * wrong one and then sit listening to it.
 *
 * The credential is not on this list. Google's libraries resolve Application
 * Default Credentials on their own — `GOOGLE_APPLICATION_CREDENTIALS` pointing
 * at a service account key file, or the metadata server on a Google host — and
 * reading it here would mean roma having an opinion about a mechanism that
 * already works and is already documented.
 */
export interface ChatEnv {
  /** The project the subscription lives in. */
  readonly projectId: string
  /** The subscription's name within that project. Not a path, and not created. */
  readonly subscription: string
  readonly maxMessages: number
  readonly maxLeaseMinutes: number
}

/** Read the Chat channel's own settings. Refuses with everything missing at once. */
export function readChatEnv(env: Environment): ChatEnv {
  const problems: string[] = []

  const projectId = required(env, 'ROMA_PUBSUB_PROJECT_ID', problems)
  const subscription = required(env, 'ROMA_PUBSUB_SUBSCRIPTION', problems)
  const maxMessages = wholeNumber(env, 'ROMA_PUBSUB_MAX_MESSAGES', problems)
  const maxLeaseMinutes = wholeNumber(env, 'ROMA_PUBSUB_MAX_LEASE_MINUTES', problems)

  if (problems.length > 0) throw new ConfigurationMissing(problems)

  return {
    projectId: certain(projectId),
    subscription: certain(subscription),
    maxMessages: maxMessages ?? DEFAULT_MAX_MESSAGES,
    maxLeaseMinutes: maxLeaseMinutes ?? DEFAULT_MAX_LEASE_MINUTES,
  }
}
