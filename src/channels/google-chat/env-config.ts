import {
  ConfigurationMissing,
  certain,
  required,
  unconfigured,
  wholeNumber,
  type Environment,
} from '../../env-config.js'

/**
 * How many messages roma will hold a lease on at once.
 * Enforced by `fence:gchat-flow-control-above-the-cap`.
 */
export const DEFAULT_MAX_MESSAGES = 20

/**
 * How long the client library keeps extending a message's acknowledgement
 * deadline before giving up on it. A parked Task can outlast it. Past it the
 * message is delivered again: dropped while the original is still in flight, a
 * second run if the original has finished.
 */
export const DEFAULT_MAX_LEASE_MINUTES = 60

/**
 * What Google Chat needs to know to reach the queue Chat publishes to. Read,
 * never created. The credential is not here: Google's libraries resolve
 * Application Default Credentials on their own.
 */
export interface ChatEnv {
  /** The project the subscription lives in. */
  readonly projectId: string
  /** The subscription's name within that project. Not a path, and not created. */
  readonly subscription: string
  readonly maxMessages: number
  readonly maxLeaseMinutes: number
}

const CHAT_VARIABLES = [
  'ROMA_PUBSUB_PROJECT_ID',
  'ROMA_PUBSUB_SUBSCRIPTION',
  'ROMA_PUBSUB_MAX_MESSAGES',
  'ROMA_PUBSUB_MAX_LEASE_MINUTES',
]

/**
 * Read the Chat Channel's own settings, or null where this deployment does not
 * serve Chat. Throws `ConfigurationMissing` naming everything missing at once.
 */
export function readChatEnv(env: Environment): ChatEnv | null {
  if (unconfigured(env, CHAT_VARIABLES)) return null

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
