import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContainmentRefused, type RootSystem } from '../drop-root.js'
import { ConfigurationMissing } from '../env-config.js'
import type { Gateway } from '../egress/egress-proxy.js'
import { EgressRefused } from '../egress/route.js'
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

describe('the keys roma reads at boot', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

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
      ROMA_EGRESS_TOKEN_FILE: join(dir, 'egress.token'),
    }
    writeFileSync(files.ROMA_GITHUB_PRIVATE_KEY_FILE, 'not-a-real-pem')
    writeFileSync(files.ROMA_CLOUD_KEY_FILE, serviceAccount)
    writeFileSync(files.ROMA_DOCUMENT_KEY_FILE, serviceAccount)
    writeFileSync(files.ROMA_EGRESS_TOKEN_FILE, 'e'.repeat(64))
    return {
      files,
      env: {
        ...MINIMAL,
        ...files,
        ROMA_EGRESS_GATEWAY: 'http://egress:3128',
        ROMA_DOCUMENT_DEPOT: 'a-folder-id',
        ROMA_DISCORD_BOT_TOKEN: 'a-bot-token',
      },
    }
  }

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

describe('the network roma is started on', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const notRoot: RootSystem = {
    uid: () => 1000,
    becomeUser: () => {},
    procOwner: () => 1000,
    canRead: () => true,
    nodeFlags: () => [],
  }

  function behindGateway() {
    const dir = mkdtempSync(join(tmpdir(), 'roma-main-egress-'))
    dirs.push(dir)
    const tokenFile = join(dir, 'egress.token')
    writeFileSync(tokenFile, 'e'.repeat(64))
    return {
      ...MINIMAL,
      ROMA_GITHUB_PRIVATE_KEY_FILE: join(dir, 'github-app.pem'),
      ROMA_DISCORD_BOT_TOKEN: 'a-bot-token',
      ROMA_EGRESS_GATEWAY: 'http://egress:3128',
      ROMA_EGRESS_TOKEN_FILE: tokenFile,
    }
  }

  it('is refused when it lets roma out without the gateway, before roma routes anything through it [fence:startup-refuses-an-open-network]', async () => {
    const env = behindGateway()
    writeFileSync(env.ROMA_GITHUB_PRIVATE_KEY_FILE, 'not-a-real-pem')
    const routed: Gateway[] = []
    const logged: unknown[] = []

    const started = startConfiguredRoma(env, (record) => logged.push(record), notRoot, {
      probe: () => Promise.resolve(true),
      route: (gateway) => routed.push(gateway),
    })

    await expect(started).rejects.toThrow(EgressRefused)
    await expect(started).rejects.toThrow(/--internal/)
    expect(routed).toEqual([])
    expect(logged).not.toContainEqual(expect.objectContaining({ event: 'egress' }))
  })
})
