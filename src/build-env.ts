/**
 * The credential a Claude Code process runs under.
 *
 * A union rather than two optional fields, because the two are mutually
 * exclusive in fact and not only in intent: Claude Code resolves credentials in
 * precedence order, so a process handed both runs on one and silently changes
 * model (ADR-0003 measured claude-sonnet-5 under the OAuth token and
 * claude-opus-5[1m] the moment a stray ANTHROPIC_API_KEY appeared).
 */
export type Credential =
  | { readonly kind: 'shared-window'; readonly oauthToken: string }
  | { readonly kind: 'overflow'; readonly apiKey: string }

/**
 * Which of the two a Task ran on, without the secret that goes with it.
 *
 * What an audit record carries: the question it answers is which of the two
 * bills a Task landed on, and the token itself has no business on disk.
 */
export type CredentialKind = Credential['kind']

export interface BuildEnvOptions {
  readonly credential: Credential
  /**
   * CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here.
   * Omitted, the process resolves credentials against whatever the host has —
   * including a keychain login that does not exist inside a container.
   */
  readonly configDir?: string
  /** The host environment to draw passthrough variables from. */
  readonly inherit?: Readonly<Record<string, string | undefined>>
}

/**
 * The only host variables a Claude Code process gets. Everything else — every
 * other credential, every unrelated secret — stays behind.
 */
const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR'] as const

/**
 * Construct a Claude Code process environment explicitly.
 *
 * Nothing is inherited implicitly. A variable the host does not define is left
 * *absent* rather than set to an empty string — an empty string still occupies
 * its slot in credential precedence, which is the difference between "resolve
 * the next credential" and "fail with this one".
 */
export function buildEnv({
  credential,
  configDir,
  inherit = process.env,
}: BuildEnvOptions): Record<string, string> {
  const env: Record<string, string> = {}

  for (const name of PASSTHROUGH) {
    const value = inherit[name]
    if (value !== undefined) env[name] = value
  }

  if (configDir !== undefined) {
    env['CLAUDE_CONFIG_DIR'] = configDir
    env['CLAUDE_SECURESTORAGE_CONFIG_DIR'] = configDir
  }

  if (credential.kind === 'shared-window') env['CLAUDE_CODE_OAUTH_TOKEN'] = credential.oauthToken
  else env['ANTHROPIC_API_KEY'] = credential.apiKey

  return env
}
