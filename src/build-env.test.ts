import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'

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

    // Absent, not empty. An empty string still occupies its slot in Claude Code's
    // credential precedence, and a present ANTHROPIC_API_KEY silently moves the
    // model from claude-sonnet-5 to claude-opus-5[1m] (ADR-0003).
    it('leaves ANTHROPIC_API_KEY absent rather than empty', () => {
      expect('ANTHROPIC_API_KEY' in env).toBe(false)
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

  it('omits a passthrough variable the host does not define', () => {
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: { PATH: '/usr/bin' },
      configDir: CONFIG_DIR,
    })

    expect('TMPDIR' in env).toBe(false)
  })

  // Both are needed to isolate a Session's credential resolution: without the
  // securestorage dir the process can still reach the machine's keychain login.
  // The same directory is where Claude Code writes the Transcript, which
  // ADR-0005 makes the only record of what an agent did — so this one variable
  // decides both, and neither is conditional on a deployment naming it.
  it('isolates credential resolution by setting both Claude config dirs', () => {
    const env = buildEnv({
      credential: { kind: 'shared-window', oauthToken: 'oauth-token' },
      inherit: HOST,
      configDir: CONFIG_DIR,
    })

    expect(env['CLAUDE_CONFIG_DIR']).toBe(CONFIG_DIR)
    expect(env['CLAUDE_SECURESTORAGE_CONFIG_DIR']).toBe(CONFIG_DIR)
  })
})
