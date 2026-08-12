import {
  ConfigurationMissing,
  certain,
  envValue,
  required,
  unconfigured,
  type Environment,
} from '../../env-config.js'

/**
 * Which Discord roma speaks.
 *
 * **Never give the two URLs below versions of their own.** A Gateway on one and
 * a REST call on another is roma reading one shape and asking for a different
 * one, which fails inside a payload rather than at boot.
 */
const API_VERSION = 10

/**
 * Where a first connection goes, and where the REST calls go.
 *
 * Constants a deployment inherits rather than variables it states, and
 * overridable all the same — both halves of that are ADR-0029's, in its
 * consequence about what a deployment is asked for.
 *
 * A resumed connection goes neither place: `READY` names its own URL, and the
 * Transport uses that.
 */
export const DEFAULT_GATEWAY_URL = `wss://gateway.discord.gg/?v=${API_VERSION}&encoding=json`
export const DEFAULT_API_BASE = `https://discord.com/api/v${API_VERSION}`

/**
 * What Discord needs to know to reach the guild roma answers.
 *
 * One secret and two addresses, and nothing else — no guild id, no application
 * id, no allowlist. The token names the application, `READY` names roma's own
 * user, `GUILD_CREATE` names every guild it is in, and guild membership is the
 * whole of the authorisation (ADR-0029). Everything roma would otherwise have to
 * be told arrives over the socket, which is one fewer thing a deployment can set
 * to the wrong value.
 */
export interface DiscordEnv {
  /** The bot token. Sent on identify and on every resume. */
  readonly botToken: string
  readonly gatewayUrl: string
  readonly apiBase: string
}

/** Every variable this Channel reads, required and optional alike. See `unconfigured`. */
const DISCORD_VARIABLES = [
  'ROMA_DISCORD_BOT_TOKEN',
  'ROMA_DISCORD_GATEWAY_URL',
  'ROMA_DISCORD_API_BASE',
]

/**
 * Read the Discord Channel's own settings, or nothing where this deployment does
 * not serve Discord.
 *
 * Refuses with everything missing at once, and null is not one of those things:
 * `ReadChannelEnv` is where the difference between a Channel a deployment does
 * not have and one it configured half of is argued.
 */
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
