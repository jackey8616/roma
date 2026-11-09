import {
  ConfigurationMissing,
  certain,
  required,
  unconfigured,
  wholeNumber,
  type Environment,
} from '../../env-config.js'

export const DEFAULT_MAX_MESSAGES = 20

export const DEFAULT_MAX_LEASE_MINUTES = 60

export interface ChatEnv {
  readonly projectId: string
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
