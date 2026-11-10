import { readFileSync } from 'node:fs'
import { ConfigurationMissing, envValue, type Environment } from '../env-config.js'
import { isPattern } from './allowlist.js'
import type { Gateway } from './egress-proxy.js'

export const EGRESS_GATEWAY_VAR = 'ROMA_EGRESS_GATEWAY'
export const EGRESS_TOKEN_FILE_VAR = 'ROMA_EGRESS_TOKEN_FILE'
export const EGRESS_ALLOW_VAR = 'ROMA_EGRESS_ALLOW'

export const NO_GATEWAY = 'none'

export interface EgressEnv {
  readonly gateway: Gateway
  readonly extra: readonly string[]
}

export function readEgressEnv(env: Environment): EgressEnv | null {
  const url = envValue(env, EGRESS_GATEWAY_VAR)
  const tokenFile = envValue(env, EGRESS_TOKEN_FILE_VAR)
  const allow = envValue(env, EGRESS_ALLOW_VAR)
  if (url === null && tokenFile === null && allow === null) {
    throw new ConfigurationMissing([
      `${EGRESS_GATEWAY_VAR} is not set. Without an egress gateway the agent reaches any host ` +
        'on the internet, and anything it can read can leave with it (ADR-0035). Run roma ' +
        'with compose.yaml, which starts the gateway, or set ' +
        `${EGRESS_GATEWAY_VAR}=${NO_GATEWAY} to run with no allowlist on purpose.`,
    ])
  }
  if (url === NO_GATEWAY) {
    if (tokenFile === null && allow === null) return null
    throw new ConfigurationMissing([
      `${EGRESS_GATEWAY_VAR} is "${NO_GATEWAY}", but ${[EGRESS_TOKEN_FILE_VAR, EGRESS_ALLOW_VAR]
        .filter((name) => envValue(env, name) !== null)
        .join(' and ')} is set — with no gateway nothing is enforced. Name the gateway, ` +
        'or unset the rest.',
    ])
  }

  const problems: string[] = []
  if (url === null) {
    problems.push(
      `${EGRESS_GATEWAY_VAR} is not set, but ${[EGRESS_TOKEN_FILE_VAR, EGRESS_ALLOW_VAR]
        .filter((name) => envValue(env, name) !== null)
        .join(' and ')} is — without a gateway nothing is enforced. Set it to the ` +
        'egress gateway, such as http://egress:3128, or unset the rest.',
    )
  } else if (!isGatewayUrl(url)) {
    problems.push(
      `${EGRESS_GATEWAY_VAR} is "${url}", which is not http://<host>:<port> with nothing after it.`,
    )
  }

  const token = tokenFile === null ? null : readToken(tokenFile, problems)
  if (tokenFile === null) {
    problems.push(
      `${EGRESS_TOKEN_FILE_VAR} is not set. The gateway refuses whoever lacks its token, ` +
        'which is the whole of what keeps the agent from using it as roma.',
    )
  }

  const extra = (allow ?? '')
    .split(',')
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern !== '')
  const malformed = extra.filter((pattern) => !isPattern(pattern))
  if (malformed.length > 0) {
    problems.push(
      `${EGRESS_ALLOW_VAR} names ${malformed.map((pattern) => `"${pattern}"`).join(', ')}, ` +
        'which is not a host name or *.<host name>. Addresses and ports are not allowed.',
    )
  }

  if (problems.length > 0) throw new ConfigurationMissing(problems)
  return { gateway: { url: url ?? '', token: token ?? '' }, extra }
}

function isGatewayUrl(text: string): boolean {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    url.port !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  )
}

function readToken(path: string, problems: string[]): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (error) {
    problems.push(
      `${EGRESS_TOKEN_FILE_VAR} is "${path}", which roma could not read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
  if (text.length < 32 || /\s/.test(text)) {
    problems.push(
      `${EGRESS_TOKEN_FILE_VAR} is "${path}", which does not hold one token of at least 32 ` +
        'characters. Make one with `openssl rand -hex 32`.',
    )
    return null
  }
  return text
}
