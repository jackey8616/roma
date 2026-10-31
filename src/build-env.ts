import { MINTER_SOCKET_VAR, SESSION_ID_VAR } from './shim-protocol.js'

/**
 * The credential a Claude Code process runs under: one of the two, never both.
 * Enforced by `fence:buildenv-one-credential-at-a-time`.
 */
export type Credential =
  | { readonly kind: 'shared-window'; readonly oauthToken: string }
  | { readonly kind: 'overflow'; readonly apiKey: string }

/** Which of the two a Task ran on, without the secret that goes with it: what an Audit Record carries. */
export type CredentialKind = Credential['kind']

/**
 * What `system/init.apiKeySource` reports for a process run on this credential:
 * the other side of `buildEnv`. Enforced by `fence:buildenv-one-api-key-source-table`.
 */
export function apiKeySourceFor(credential: CredentialKind): string {
  return credential === 'shared-window' ? 'none' : 'ANTHROPIC_API_KEY'
}

/**
 * What a Session's Credential Shims need to find roma, and to say who is asking.
 *
 * Absent for the startup self-check's probe, which is not a Session roma serves
 * and has no Shims of its own to reach anything with.
 */
export interface SessionShims {
  /** The Session id, which is what a Shim reports a credential request under. */
  readonly sessionId: string
  /** The Unix domain socket the Minter answers on. */
  readonly socketPath: string
  /**
   * The gitconfig `GIT_CONFIG_GLOBAL` points at, which puts the `git` Shim in
   * front of `git`. The path is fixed at spawn; the file's contents are roma's to
   * rewrite without re-spawning.
   */
  readonly gitConfigPath: string
}

export interface BuildEnvOptions {
  readonly credential: Credential
  /**
   * CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here.
   * Enforced by `fence:buildenv-config-dir-is-required`.
   */
  readonly configDir: string
  /** How this Session's tools reach roma for a credential. */
  readonly shims?: SessionShims
  /** The host environment to draw passthrough variables from. */
  readonly inherit?: Readonly<Record<string, string | undefined>>
}

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR'] as const

/**
 * Construct a Claude Code process environment explicitly. Nothing is inherited
 * implicitly, and a variable the host does not define is left absent.
 * Enforced by `fence:buildenv-unset-stays-absent`.
 */
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

  // Two variables of roma's own, and this file's whole rule is that it admits
  // almost nothing — so widening the list needs saying rather than doing.
  //
  // They are admissible for exactly the reasons an Installation Token is not.
  // Neither is a secret: the Session id is already visible in the working
  // directory path the process is started in, and the socket path is a path.
  // Neither expires, so neither goes stale in an environment that is fixed at
  // spawn while the process outlives an hour — which is the arithmetic that
  // keeps the credential itself out of here (ADR-0008).
  if (shims !== undefined) {
    env[SESSION_ID_VAR] = shims.sessionId
    env[MINTER_SOCKET_VAR] = shims.socketPath
    env['GIT_CONFIG_GLOBAL'] = shims.gitConfigPath
  }

  return env
}
