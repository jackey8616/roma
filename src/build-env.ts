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
  readonly credential: Credential
  readonly configDir: string
  readonly shims?: SessionShims
  readonly inherit?: Readonly<Record<string, string | undefined>>
}

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR'] as const

export function buildEnv({
  credential,
  configDir,
  shims,
  inherit = process.env,
}: BuildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}

  for (const name of PASSTHROUGH) {
    const value = inherit[name]
    if (value !== undefined) env[name] = value
  }

  env['CLAUDE_CONFIG_DIR'] = configDir
  env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = configDir

  if (credential.kind === 'shared-window') env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.oauthToken
  else env['ANTHROPIC_API_KEY'] = credential.apiKey

  if (shims !== undefined) {
    env[SESSION_ID_VAR] = shims.sessionId
    env[MINTER_SOCKET_VAR] = shims.socketPath
    env['GIT_CONFIG_GLOBAL'] = shims.gitConfigPath
  }

  return env
}
