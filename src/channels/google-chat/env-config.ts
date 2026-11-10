import {
  ConfigurationMissing,
  certain,
  envValue,
  required,
  unconfigured,
  wholeNumber,
  type Environment,
} from '../../env-config.js'

export const DEFAULT_MAX_MESSAGES = 20

const IDENTITY_KEY_FILE_VAR = 'GOOGLE_APPLICATION_CREDENTIALS'

export function chatIdentityKeyFileIn(env: Environment): { variable: string; path: string }[] {
  const path = envValue(env, IDENTITY_KEY_FILE_VAR)
  return path === null ? [] : [{ variable: IDENTITY_KEY_FILE_VAR, path }]
}

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
