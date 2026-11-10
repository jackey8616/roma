import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContainmentRefused, type RootSystem } from '../drop-root.js'
import { ConfigurationMissing } from '../env-config.js'
import type { Gateway } from '../egress/egress-proxy.js'
import { EgressRefused } from '../egress/route.js'
import type { AuditSealSystem } from '../audit-seal.js'
import { startConfiguredRoma } from './main.js'
import { FakeLauncher } from '../../test/support/fake-launcher.js'
import { FakeCloudMinter, FakeMinter, fakeReaches } from '../../test/support/fake-minter.js'
import { FakeRuntime } from '../../test/support/fake-runtime.js'

const launcher = () => new FakeLauncher('/nonexistent', new FakeRuntime().spawn)

function sealable(calls: string[] = [], uid: () => number = () => 1000): AuditSealSystem {
  return {
    self: () => ({ uid: uid(), gid: uid() }),
    seats: () => [{ uid: 20000, gid: 20000 }],
    makeDirectory: () => {},
    inspect: () => {
      calls.push(`sealedAs:${uid()}`)
      return { uid: uid(), gid: uid(), mode: 0o40700 }
    },
    owner: () => 0,
    mountPoint: () => false,
    realPath: (path) => path,
    entries: () => [],
    tighten: () => {},
  }
}

const MINIMAL = {
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
  ROMA_WORK_ROOT: '/srv/roma/sessions',
  ROMA_AUDIT_ROOT: '/var/lib/roma/audit',
  ROMA_CLAUDE_CONFIG_DIR: '/srv/roma/claude',
  ROMA_SHIM_DIR: '/run/roma',
  ROMA_GITHUB_APP_ID: '1234',
  ROMA_GITHUB_PRIVATE_KEY_FILE: '/run/secrets/github-app.pem',
  ROMA_EGRESS_GATEWAY: 'none',
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
      keyFileMode: () => ({ uid: 0, mode: 0o100400 }),
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
      launcher(),
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

    const started = startConfiguredRoma(missing, () => {}, root, launcher())

    await expect(started).rejects.toThrow(ConfigurationMissing)
    await expect(started).rejects.toThrow(/github-app\.pem/)
    await expect(started).rejects.toThrow(/still root/)
    expect(becameUser).toBe(true)
  })

  it('tell the Launcher where Sessions live while roma is still root [fence:main-writes-the-launcher-roots-before-the-drop]', async () => {
    const why =
      'ADR-0036: the Launcher takes no path from roma and trusts only a roots file root owns ' +
      'and nobody else can write. Once roma is node it can write no such file, and a Launcher ' +
      'without one refuses every Session.'
    const { env } = keyed()
    const told: string[] = []
    const fake = launcher()
    const root: RootSystem = {
      ...rootThatLeavesKeysReadable(),
      becomeUser: () => {
        told.push(fake.roots === null ? 'dropped before the roots' : 'dropped after the roots')
        throw new Error('stop here')
      },
    }

    await expect(startConfiguredRoma(env, () => {}, root, fake)).rejects.toThrow(ContainmentRefused)
    expect(told, why).toEqual(['dropped after the roots'])
    expect(fake.roots, why).toEqual({
      work: MINIMAL.ROMA_WORK_ROOT,
      config: MINIMAL.ROMA_CLAUDE_CONFIG_DIR,
      shim: MINIMAL.ROMA_SHIM_DIR,
    })
  })
})

describe('the network roma is started on', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const rootThatDrops = (): RootSystem => {
    let uid = 0
    return {
      uid: () => uid,
      becomeUser: () => {
        uid = 1000
      },
      procOwner: () => 0,
      canRead: () => false,
      keyFileMode: () => ({ uid: 0, mode: 0o100400 }),
      nodeFlags: () => ['--disable-sigusr1'],
    }
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

    const started = startConfiguredRoma(
      env,
      (record) => logged.push(record),
      rootThatDrops(),
      launcher(),
      {
        probe: () => Promise.resolve(true),
        route: (gateway) => routed.push(gateway),
      },
      sealable(),
    )

    await expect(started).rejects.toThrow(EgressRefused)
    await expect(started).rejects.toThrow(/--internal/)
    expect(routed).toEqual([])
    expect(logged).not.toContainEqual(expect.objectContaining({ event: 'egress' }))
  })
})

describe('the Audit Records', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('are sealed from every Seat once roma is node, before anything is served [fence:main-seals-audit-after-drop]', async () => {
    const why =
      'ADR-0037: roma owns the audit root and must seal it as the uid that owns it, after the ' +
      'drop and before a Session exists. Sealed as root it would check the wrong owner; sealed ' +
      'later, an agent could already be running beside an open ledger.'
    const dir = mkdtempSync(join(tmpdir(), 'roma-main-audit-'))
    dirs.push(dir)
    const key = join(dir, 'github-app.pem')
    writeFileSync(key, 'not-a-real-pem')
    let uid = 0
    const calls: string[] = []
    const root: RootSystem = {
      uid: () => uid,
      becomeUser: () => {
        calls.push('becomeUser')
        uid = 1000
      },
      procOwner: () => 0,
      canRead: () => false,
      keyFileMode: () => ({ uid: 0, mode: 0o100400 }),
      nodeFlags: () => ['--disable-sigusr1'],
    }
    const logged: unknown[] = []

    await startConfiguredRoma(
      { ...MINIMAL, ROMA_GITHUB_PRIVATE_KEY_FILE: key, ROMA_DISCORD_BOT_TOKEN: 'a-bot-token' },
      (record) => logged.push(record),
      root,
      launcher(),
      { probe: () => Promise.resolve(true), route: () => {} },
      sealable(calls, () => uid),
    ).catch(() => {})

    expect(calls[0], why).toBe('becomeUser')
    expect(
      calls.slice(1).every((call) => call === 'sealedAs:1000'),
      why,
    ).toBe(true)
    expect(calls.length, why).toBeGreaterThan(1)
    expect(logged, why).toContainEqual({ event: 'audit', sealed: true, tightened: false })
  })
})

describe('one refusal, whatever found the problem [fence:main-one-refusal-across-live-checks]', () => {
  const why =
    'Every configuration problem roma can find at boot must arrive in one refusal, including ' +
    'what only a network round trip or a check made as node can find (ADR-0015 §8, #103, ' +
    '#218). Refusing in two steps turns standing roma up into a sequence of boots.'
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const rootThatDrops = (onDrop: () => void = () => {}): RootSystem => {
    let uid = 0
    return {
      uid: () => uid,
      becomeUser: () => {
        onDrop()
        uid = 1000
      },
      procOwner: () => 0,
      canRead: () => false,
      keyFileMode: () => ({ uid: 0, mode: 0o100400 }),
      nodeFlags: () => ['--disable-sigusr1'],
    }
  }

  function deployment() {
    const dir = mkdtempSync(join(tmpdir(), 'roma-main-refusal-'))
    dirs.push(dir)
    const key = join(dir, 'github-app.pem')
    writeFileSync(key, 'not-a-real-pem')
    return {
      dir,
      env: { ...MINIMAL, ROMA_GITHUB_PRIVATE_KEY_FILE: key, ROMA_DISCORD_BOT_TOKEN: 'a-bot-token' },
    }
  }

  function start(
    env: Record<string, string | undefined>,
    reaches: Parameters<typeof fakeReaches>[0],
    root: RootSystem = rootThatDrops(),
  ) {
    const started = startConfiguredRoma(
      env,
      () => {},
      root,
      launcher(),
      { probe: () => Promise.resolve(false), route: () => {} },
      sealable(),
      () => fakeReaches(reaches),
    )
    started.catch(() => {})
    return started
  }

  async function refusal(started: Promise<unknown>): Promise<readonly string[]> {
    const error: unknown = await started.then(
      () => expect.unreachable('should have refused'),
      (refused: unknown) => refused,
    )
    expect(error, why).toBeInstanceOf(ConfigurationMissing)
    return (error as ConfigurationMissing).problems
  }

  it('names a missing variable and a revoked cloud key together', async () => {
    const { env } = deployment()
    const problems = await refusal(
      start(
        { ...env, ROMA_AUDIT_ROOT: undefined },
        { cloudMinter: new FakeCloudMinter({ failsWith: new Error('the key was revoked') }) },
      ),
    )

    expect(problems[0], why).toBe('ROMA_AUDIT_ROOT is not set.')
    expect(problems[1], why).toMatch(/Cloud Reach .* the key was revoked/)
  })

  it('names a missing variable and a forge that refused together, and touches no other provider', async () => {
    const { env } = deployment()
    const cloudMinter = new FakeCloudMinter()
    const problems = await refusal(
      start(
        { ...env, ROMA_AUDIT_ROOT: undefined },
        { minter: new FakeMinter({ failsWith: new Error('a bad private key') }), cloudMinter },
      ),
    )

    expect(problems, why).toEqual(['ROMA_AUDIT_ROOT is not set.', 'a bad private key'])
    expect(cloudMinter.minted, why).toEqual([])
  })

  it('lets a forge refusal through as it is when it is the only thing wrong', async () => {
    const { env } = deployment()
    const refused = new Error('a bad private key')

    await expect(start(env, { minter: new FakeMinter({ failsWith: refused }) })).rejects.toBe(
      refused,
    )
  })

  it('names a missing ROMA_CODEX_HOME beside a missing variable', async () => {
    const { env, dir } = deployment()
    const codexHome = join(dir, 'no-codex-here')
    const problems = await refusal(
      start({ ...env, ROMA_AUDIT_ROOT: undefined, ROMA_CODEX_HOME: codexHome }, {}),
    )

    expect(problems, why).toEqual([
      'ROMA_AUDIT_ROOT is not set.',
      `ROMA_CODEX_HOME is ${codexHome}, which does not exist.`,
    ])
  })

  it('refuses a ROMA_CODEX_HOME nobody seeded, even with everything else in order', async () => {
    const { env, dir } = deployment()
    const codexHome = join(dir, 'codex')
    mkdirSync(codexHome)

    const problems = await refusal(start({ ...env, ROMA_CODEX_HOME: codexHome }, {}))

    expect(problems, why).toEqual([expect.stringContaining(join(codexHome, 'auth.json'))])
  })

  it('checks ROMA_CODEX_HOME once roma is node, which is who has to write to it [fence:main-checks-codex-home-after-drop]', async () => {
    const after =
      'A writability check made as root passes on any directory, so ROMA_CODEX_HOME must be ' +
      'checked after the drop, as the user that will write to it (#218).'
    const { env, dir } = deployment()
    const codexHome = join(dir, 'codex')
    mkdirSync(codexHome)
    const seedOnDrop = rootThatDrops(() => writeFileSync(join(codexHome, 'auth.json'), '{}'))

    const problems = await refusal(
      start({ ...env, ROMA_AUDIT_ROOT: undefined, ROMA_CODEX_HOME: codexHome }, {}, seedOnDrop),
    )

    expect(problems, after).toEqual(['ROMA_AUDIT_ROOT is not set.'])
  })
})
