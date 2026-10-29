import { describe, expect, it } from 'vitest'
import { buildEnv, type BuildEnvOptions, type Credential } from './build-env.js'

// The host environment a test pretends to be running under. It deliberately
// carries both credentials and an unrelated secret, because the point of
// buildEnv is that none of that leaks into a Claude Code process by accident.
const HOST = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/roma',
  USER: 'roma',
  SHELL: '/bin/zsh',
  LANG: 'en_GB.UTF-8',
  TMPDIR: '/tmp/host',
  ANTHROPIC_API_KEY: 'a-key-that-happened-to-be-exported',
  CLAUDE_CODE_EFFORT_LEVEL: 'low',
  CLAUDE_CODE_OAUTH_TOKEN: 'a-token-that-happened-to-be-exported',
  AWS_SECRET_ACCESS_KEY: 'nothing-to-do-with-claude',
}

/** Where a Session's Claude Code state goes. Required, so every call names one. */
const CONFIG_DIR = '/work/claude-home'

describe('buildEnv', () => {
  describe('under a Shared Window credential', () => {
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    it('passes the OAuth token', () => {
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-token')
    })

    it('leaves ANTHROPIC_API_KEY absent rather than empty [fence:buildenv-no-stray-key]', () => {
      const why =
        'A Shared Window process must have no ANTHROPIC_API_KEY at all: not inherited from the ' +
        'host, and not set to an empty string (ADR-0002). A key, when set, always overrides the ' +
        'subscription in non-interactive mode, so a stray one silently routes every run to ' +
        'metered billing; an empty one still occupies its slot in the precedence order.'
      expect('ANTHROPIC_API_KEY' in env, why).toBe(false)
    })
  })

  describe('under an Overflow credential', () => {
    const env = buildEnv({
      credential: { kind: 'overflow', apiKey: 'api-key' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    it('passes the API key', () => {
      expect(env['ANTHROPIC_API_KEY']).toBe('api-key')
    })

    it('leaves CLAUDE_CODE_OAUTH_TOKEN absent rather than empty', () => {
      expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false)
    })
  })

  it('carries only the named passthrough variables from the host', () => {
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    expect(env['PATH']).toBe('/usr/bin:/bin')
    expect(env['HOME']).toBe('/home/roma')
    expect(env['LANG']).toBe('en_GB.UTF-8')
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false)
  })

  /**
   * The allowlist stopped being only about credentials at ADR-0016, and this is
   * the test that says so.
   *
   * Precedence was measured as `CLAUDE_CODE_EFFORT_LEVEL` > `--effort` >
   * `settings.effortLevel`, so a host that exports this beats every `--effort`
   * roma passes — and roma would go on reporting, and recording, the level it
   * asked for. Nothing else in roma stands between the host environment and the
   * effort of every Session it serves.
   *
   * It already passes, because `PASSTHROUGH` is an allowlist and this was never
   * on it. That is the point: the property is free and load-bearing, so
   * narrowing that list is now a decision about effort as well as about
   * credentials, and this is where somebody finds that out.
   */
  it('keeps a host CLAUDE_CODE_EFFORT_LEVEL out, which would otherwise beat --effort [fence:buildenv-no-host-effort]', () => {
    const why =
      'A host CLAUDE_CODE_EFFORT_LEVEL must never reach a Claude Code process (ADR-0016). ' +
      'Precedence was measured as CLAUDE_CODE_EFFORT_LEVEL > --effort > settings.effortLevel, ' +
      'so it would beat every --effort roma passes while roma went on reporting and recording ' +
      'the level it asked for. PASSTHROUGH is about effort now as well as credentials.'
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    expect('CLAUDE_CODE_EFFORT_LEVEL' in env, why).toBe(false)
  })

  it('omits a passthrough variable the host does not define [fence:buildenv-unset-stays-absent]', () => {
    const why =
      'A host variable that is not defined must be left absent from a Claude Code process, ' +
      'never set to an empty string: an empty string still occupies its slot in credential ' +
      'precedence, which is the difference between "resolve the next credential" and "fail with ' +
      'this one" (ADR-0002, ADR-0003; #19).'
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: { PATH: '/usr/bin' },
      configDir: CONFIG_DIR,
    })

    expect(Object.keys(env).sort(), why).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'PATH',
    ])
  })

  it('cannot be handed both credentials at once [fence:buildenv-one-credential-at-a-time]', () => {
    const why =
      'A Credential is one of the Shared Window token or the Overflow key, never both: Claude ' +
      'Code resolves credentials in precedence order, so a process handed both silently runs ' +
      'on one and changes model (ADR-0003 measured claude-sonnet-5 under the OAuth token and ' +
      'claude-opus-5[1m] once a stray ANTHROPIC_API_KEY appeared; #19). Credential is a ' +
      'discriminated union so that the object below does not compile.'
    const both = {
      kind: 'shared-window',
      oauthToken: 'oauth-token',
      apiKey: 'api-key',
    } as const
    // @ts-expect-error -- fence:buildenv-one-credential-at-a-time: a Credential carrying both halves must not compile.
    const credential: Credential = { kind: 'overflow', apiKey: 'k', oauthToken: 't' }

    const env = buildEnv({ credential: both as Credential, inherit: HOST, configDir: CONFIG_DIR })

    expect(credential.kind, why).toBe('overflow')
    expect(
      ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].filter((name) => name in env),
      why,
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  })

  // Both are needed to isolate a Session's credential resolution: without the
  // securestorage dir the process can still reach the machine's keychain login.
  // The same directory is where Claude Code writes the Transcript, which
  // ADR-0005 makes the only record of what an agent did — so this one variable
  // decides both, and neither is conditional on a deployment naming it.
  it('isolates credential resolution by setting both Claude config dirs [fence:buildenv-config-dir-is-required]', () => {
    const why =
      'buildEnv must always set CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR, and ' +
      'configDir is required by its type. Without them a process resolves credentials against ' +
      'whatever the host has, keychain included (ADR-0002), and writes its Transcript under the ' +
      'passthrough HOME rather than somewhere roma named (ADR-0005; #37).'
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })
    // @ts-expect-error -- fence:buildenv-config-dir-is-required: configDir must stay required.
    const unnamed: BuildEnvOptions = { credential: { kind: 'shared-window', oauthToken: 'x' } }

    expect(unnamed.credential.kind, why).toBe('shared-window')
    expect(env['CLAUDE_CONFIG_DIR'], why).toBe(CONFIG_DIR)
    expect(env['CLAUDE_SECURESTORAGE_CONFIG_DIR'], why).toBe(CONFIG_DIR)
  })

  // Three variables, widening an allowlist that exists to admit almost nothing.
  // They are admissible for exactly the reasons an Installation Token is not:
  // none is a secret, and none expires — so none of them goes stale in an
  // environment that is fixed at spawn while the process outlives an hour.
  describe('with Credential Shims in front of a Session’s tools', () => {
    const SHIMS = {
      sessionId: 'a-session',
      socketPath: '/run/roma/minter.sock',
      gitConfigPath: '/run/roma/gitconfig',
    }
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
      shims: SHIMS,
    })

    it('says which Session is asking, and where to ask', () => {
      expect(env['ROMA_SESSION_ID']).toBe('a-session')
      expect(env['ROMA_MINTER_SOCKET']).toBe('/run/roma/minter.sock')
    })

    it('points git at the config that puts a Shim in front of it', () => {
      expect(env['GIT_CONFIG_GLOBAL']).toBe('/run/roma/gitconfig')
    })

    // The one thing that must never be here. An environment is fixed at spawn
    // and would be stale within the hour — and `env` in a Turn writes it into a
    // Transcript roma has promised never to delete (ADR-0006).
    it('carries no credential for the forge at all', () => {
      expect(JSON.stringify(env)).not.toMatch(/gh[su]_|x-access-token/)
    })
  })

  // The startup self-check's probe is not a Session roma serves: it has no
  // Session id to report and nothing to clone.
  it('leaves the Shim variables out where there is no Session', () => {
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    expect('ROMA_SESSION_ID' in env).toBe(false)
    expect('ROMA_MINTER_SOCKET' in env).toBe(false)
    expect('GIT_CONFIG_GLOBAL' in env).toBe(false)
  })
})
