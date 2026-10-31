import { describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { startConfiguredRoma } from './main.js'

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
  it('refuses a deployment that named no Channel at all, listing the ones it could', async () => {
    await expect(startConfiguredRoma(MINIMAL, () => {})).rejects.toThrow(
      /at least one of: chat, discord/,
    )
  })

  it('refuses a Channel configured by halves, naming what is missing', async () => {
    const half = { ...MINIMAL, ROMA_PUBSUB_PROJECT_ID: 'roma-prod' }

    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(ConfigurationMissing)
    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(/ROMA_PUBSUB_SUBSCRIPTION/)
  })

  it('refuses a second Channel configured by halves on the same terms', async () => {
    const half = { ...MINIMAL, ROMA_DISCORD_API_BASE: 'https://discord.internal/api/v10' }

    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(/ROMA_DISCORD_BOT_TOKEN/)
  })
})
