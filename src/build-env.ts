import { MINTER_SOCKET_VAR, SESSION_ID_VAR } from './shim-protocol.js'

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

/**
 * What `system/init.apiKeySource` reports for a process run on this credential.
 *
 * The other side of `buildEnv`: that decides which variable is set, and this is
 * what Claude Code says about it once it has resolved one. Both values measured
 * rather than assumed — `"none"` under the OAuth token, `"ANTHROPIC_API_KEY"`
 * the moment a key is present (ADR-0002).
 *
 * One function rather than one per reader. Its two readers are the startup
 * self-check and the audit record's mismatch count, and they exist to catch the
 * same failure: a stray key silently moving every run onto metered billing. Two
 * copies that drifted would leave the check passing while the count reported
 * nothing wrong, so the one thing both were built to see would be invisible in
 * both at once.
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
   * The gitconfig `GIT_CONFIG_GLOBAL` points at, which is what puts the `git`
   * Shim in front of `git`.
   *
   * The path is fixed at spawn; the file's contents are roma's to rewrite, which
   * is what makes per-Task behaviour possible later without re-spawning anything.
   */
  readonly gitConfigPath: string
}

export interface BuildEnvOptions {
  readonly credential: Credential
  /**
   * CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, both pointed here.
   *
   * Required, and required here rather than only at the caller that reads the
   * environment: without it a process resolves credentials against whatever the
   * host has — including a keychain login that does not exist inside a container
   * — and writes its Transcript under the `HOME` this file passes through. Both
   * are unconditional promises elsewhere (ADR-0002's isolation, ADR-0005's
   * Transcript), and an option here is a way to break them that the type would
   * not mention.
   */
  readonly configDir: string
  /** How this Session's tools reach roma for a credential. */
  readonly shims?: SessionShims
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
