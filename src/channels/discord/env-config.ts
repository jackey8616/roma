import {
  ConfigurationMissing,
  certain,
  envValue,
  required,
  unconfigured,
  type Environment,
} from '../../env-config.js'

const API_VERSION = 10

export const DEFAULT_GATEWAY_URL = `wss://gateway.discord.gg/?v=${API_VERSION}&encoding=json`
export const DEFAULT_API_BASE = `https://discord.com/api/v${API_VERSION}`

export interface DiscordEnv {
  readonly botToken: string
  readonly gatewayUrl: string
  readonly apiBase: string
}

const DISCORD_VARIABLES = [
  'ROMA_DISCORD_BOT_TOKEN',
  'ROMA_DISCORD_GATEWAY_URL',
  'ROMA_DISCORD_API_BASE',
]

export function readDiscordEnv(env: Environment): DiscordEnv | null {
  if (unconfigured(env, DISCORD_VARIABLES)) return null

  const problems: string[] = []
  const botToken = required(env, 'ROMA_DISCORD_BOT_TOKEN', problems)
  if (problems.length > 0) throw new ConfigurationMissing(problems)

  return {
    botToken: certain(botToken),
    gatewayUrl: envValue(env, 'ROMA_DISCORD_GATEWAY_URL') ?? DEFAULT_GATEWAY_URL,
    apiBase: envValue(env, 'ROMA_DISCORD_API_BASE') ?? DEFAULT_API_BASE,
  }
}
