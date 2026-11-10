import type { Fronted } from './credential-proxy.js'
import { LOOPBACK } from './egress/route.js'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR } from './shim-protocol.js'

export type Credential =
  | { readonly kind: 'shared-window'; readonly oauthToken: string }
  | { readonly kind: 'overflow'; readonly apiKey: string }

export type CredentialKind = Credential['kind']

export function apiKeySourceFor(credential: CredentialKind): string {
  return credential === 'shared-window' ? 'none' : 'ANTHROPIC_API_KEY'
}

export interface SessionShims {
  readonly sessionId: string
  readonly socketPath: string
  readonly gitConfigPath: string
}

export interface BuildEnvOptions {
  readonly credential: Fronted
  readonly configDir: string
  readonly shims?: SessionShims
  readonly egressProxy?: string
  readonly inherit?: Readonly<Record<string, string | undefined>>
}

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR'] as const

const PROXY_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const

export function buildEnv({
  credential,
  configDir,
  shims,
  egressProxy,
  inherit = process.env,
}: BuildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}

  for (const name of PASSTHROUGH) {
    const value = inherit[name]
    if (value !== undefined) env[name] = value
  }

  env['CLAUDE_CONFIG_DIR'] = configDir
  env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = configDir

  if (credential.kind === 'shared-window') env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.standIn
  else env['ANTHROPIC_API_KEY'] = credential.standIn
  env['ANTHROPIC_BASE_URL'] = credential.baseUrl
  env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'

  if (egressProxy !== undefined) {
    for (const name of PROXY_VARS) env[name] = egressProxy
    for (const name of NO_PROXY_VARS) env[name] = LOOPBACK
  }

  if (shims !== undefined) {
    env[SESSION_ID_VAR] = shims.sessionId
    env[MINTER_SOCKET_VAR] = shims.socketPath
    env['GIT_CONFIG_GLOBAL'] = shims.gitConfigPath
  }

  return env
}
