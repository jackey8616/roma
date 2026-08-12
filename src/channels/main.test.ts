import { describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { startConfiguredRoma } from './main.js'

// The composition root's refusals, which are everything about it that can be
// asserted for nothing: reading the configuration comes before the credential is
// proved, before a Chat client is built and before anything is subscribed, so an
// environment roma will not start on rejects here without a network, a key or a
// Turn. What happens *after* the configuration is read is `wiring.test.ts`'s,
// where the parts are real and only Claude Code and the network are not.

/** Everything roma insists on, short of a Channel. */
const MINIMAL = {
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
  ROMA_WORK_ROOT: '/srv/roma/sessions',
  ROMA_AUDIT_ROOT: '/var/lib/roma/audit',
  ROMA_CLAUDE_CONFIG_DIR: '/srv/roma/claude',
  ROMA_SHIM_DIR: '/run/roma',
  ROMA_GITHUB_APP_ID: '1234',
  ROMA_GITHUB_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem',
}

describe('which Channels this deployment serves', () => {
  // The one deployment that is complete in every other part and still cannot
  // work. It would prove its credential, open its socket, subscribe to nothing
  // and answer nobody — so the refusal names what it could have configured
  // rather than leaving somebody to find out from the silence.
  it('refuses a deployment that named no Channel at all, listing the ones it could', async () => {
    await expect(startConfiguredRoma(MINIMAL, () => {})).rejects.toThrow(/at least one of: chat/)
  })

  // Half a Channel is refused at boot rather than served to nobody: somebody who
  // named a project meant to serve Chat, and a roma that read that as "this
  // deployment has no Chat" would start perfectly and ignore what they set
  // (ADR-0028).
  it('refuses a Channel configured by halves, naming what is missing', async () => {
    const half = { ...MINIMAL, ROMA_PUBSUB_PROJECT_ID: 'roma-prod' }

    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(ConfigurationMissing)
    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(/ROMA_PUBSUB_SUBSCRIPTION/)
  })
})
