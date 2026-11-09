import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContainmentRefused, type RootSystem } from '../drop-root.js'
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
    await expect(startConfiguredRoma(MINIMAL, () => {})).rejects.toThrow(
      /at least one of: chat, discord/,
    )
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

  // The same rule on the second Channel, which is the first evidence that it is
  // a rule rather than something Chat's reader happens to do: a deployment that
  // pointed Discord at a proxy and forgot the token is refused here too.
  it('refuses a second Channel configured by halves on the same terms', async () => {
    const half = { ...MINIMAL, ROMA_DISCORD_API_BASE: 'https://discord.internal/api/v10' }

    await expect(startConfiguredRoma(half, () => {})).rejects.toThrow(/ROMA_DISCORD_BOT_TOKEN/)
  })
})

describe('the keys roma reads at boot', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Every key file a deployment can name, real enough for its reader to accept. */
  function keyed() {
    const dir = mkdtempSync(join(tmpdir(), 'roma-main-keys-'))
    dirs.push(dir)
    const serviceAccount = JSON.stringify({
      client_email: 'reach@a-project.iam.gserviceaccount.com',
      private_key: 'not-a-real-key',
    })
    const files = {
      ROMA_GITHUB_PRIVATE_KEY_FILE: join(dir, 'github-app.pem'),
      ROMA_CLOUD_KEY_FILE: join(dir, 'cloud.json'),
      ROMA_DOCUMENT_KEY_FILE: join(dir, 'documents.json'),
    }
    writeFileSync(files.ROMA_GITHUB_PRIVATE_KEY_FILE, 'not-a-real-pem')
    writeFileSync(files.ROMA_CLOUD_KEY_FILE, serviceAccount)
    writeFileSync(files.ROMA_DOCUMENT_KEY_FILE, serviceAccount)
    return {
      files,
      env: {
        ...MINIMAL,
        ...files,
        ROMA_DOCUMENT_DEPOT: 'a-folder-id',
        ROMA_DISCORD_BOT_TOKEN: 'a-bot-token',
      },
    }
  }

  /** Started as root, and after the drop `node` can still read every one of them. */
  const rootThatLeavesKeysReadable = (): RootSystem => {
    let uid = 0
    return {
      uid: () => uid,
      becomeUser: () => {
        uid = 1000
      },
      procOwner: () => 0,
      canRead: () => true,
      nodeFlags: () => ['--disable-sigusr1'],
    }
  }

  it('are checked against the agent once roma is no longer root, every one of them [fence:main-drops-root-after-reading-keys]', async () => {
    const { env, files } = keyed()
    const logged: unknown[] = []

    const started = startConfiguredRoma(
      env,
      (record) => logged.push(record),
      rootThatLeavesKeysReadable(),
    )

    await expect(started).rejects.toThrow(ContainmentRefused)
    const message = await started.catch((error: unknown) => (error as Error).message)
    for (const [variable, path] of Object.entries(files)) {
      expect(message).toContain(`${variable} is "${path}"`)
    }
    // Refused before anything was built: nothing at all reached the log.
    expect(logged).toEqual([])
  })

  it('are read before the drop, so an unreadable one is a configuration problem rather than a containment one', async () => {
    const { env } = keyed()
    const missing = { ...env, ROMA_GITHUB_PRIVATE_KEY_FILE: '/nonexistent/github-app.pem' }
    let becameUser = false
    const root: RootSystem = {
      ...rootThatLeavesKeysReadable(),
      becomeUser: () => {
        becameUser = true
      },
    }

    await expect(startConfiguredRoma(missing, () => {}, root)).rejects.toThrow(ConfigurationMissing)
    expect(becameUser).toBe(false)
  })
})
