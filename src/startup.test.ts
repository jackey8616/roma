import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { monthOf, type AuditRecord } from './audit-log.js'
import type { Credential } from './build-env.js'
import {
  CAVEMAN_MENU,
  CAVEMAN_NOT_PINNED,
  CAVEMAN_OFF,
  cavemanRuleset,
  OFF_MENU_WENYAN,
} from './caveman.js'
import { ConfigurationMissing } from './env-config.js'
import { sessionIdFor } from './session-id.js'
import { askMinter } from './shim-client.js'
import { socketPathIn } from './shim-protocol.js'
import type { Reaches } from './reach.js'
import { bind, type ChannelBinding } from './serve.js'
import { startRoma, type Roma, type StartRomaOptions } from './startup.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import { flush } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { FakeTransport } from '../test/support/fake-transport.js'
import {
  fakeReaches,
  fakeShims,
  FakeCloudMinter,
  FakeDocumentMinter,
  FakeMinter,
} from '../test/support/fake-minter.js'
import type { ReachLogRecord } from './startup.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../test/support/roma-fixture.js'
import { feed, OK, STRAY_KEY } from '../test/support/recorded-stream.js'

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'token' }
const KEY = 'conversation-one'

const BEFORE_THE_CHECK =
  'Nothing that can take a message — no Core, no bound Channel, no socket serving credentials ' +
  '— may exist until the startup self-check has passed (#27, ADR-0002). A boot that fails the ' +
  'check must throw having built none of it, so there is nothing for a message to arrive at ' +
  'and no way to start serving one on a credential nobody verified.'

const ONE_OF_EVERYTHING =
  'Every Channel’s Core must share the one queue, pool and records startRoma builds (ADR-0028). ' +
  'The concurrency cap is three against one Shared Window, not three per Channel; a Core that ' +
  'built its own would double every cap with no configuration looking wrong.'

const REACH_LINE =
  'Every boot must write one `reach` line for every Reach, including those with no account, ' +
  'and the boot proof must write no `reach-token-minted` (#99, ADR-0020). A line that appeared ' +
  'only sometimes would make its absence mean two things — no Reach, or an older roma — and ' +
  'counting the proof’s mint, which served nobody, puts a standing +1 on every mint rate.'

let started: Roma[] = []
let fixtures: RomaFixture[] = []

function boot({
  minter = new FakeMinter(),
  cloudMinter,
  documentMinter,
  caveman,
}: {
  minter?: FakeMinter
  cloudMinter?: FakeCloudMinter
  documentMinter?: FakeDocumentMinter
  caveman?: string
} = {}) {
  const fixture = romaFixture('startup')
  fixtures.push(fixture)
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const channel = new RecordingAdapter()
  const log: ReachLogRecord[] = []

  let resolved = false
  const starting = startRoma({
    credential: OAUTH,
    channels: [bind(channel, new FakeTransport())],
    ...fixture.dirs,
    reaches: fakeReaches({
      minter,
      cloudMinter: cloudMinter ?? null,
      documentMinter: documentMinter ?? null,
    }),
    shims,
    spawn: fixture.claude.spawn,
    log: (record) => log.push(record as ReachLogRecord),
    selfCheckTimeoutMs: 1_000,
    ...(caveman === undefined ? {} : { caveman }),
  }).then((roma) => {
    resolved = true
    started.push(roma)
    return { ...roma, core: onlyCore(roma) }
  })
  starting.catch(() => {})

  return {
    claude: fixture.claude,
    channel,
    workRoot: fixture.dirs.workRoot,
    auditRoot: fixture.dirs.auditRoot,
    minter,
    cloudMinter,
    documentMinter,
    shims,
    log,
    starting,
    hasStarted: () => resolved,
    answerProbe: fixture.answerProbe,
    procFor: fixture.procFor,
    roots: fixture.roots,
  }
}

function onlyCore(roma: Roma) {
  const [channel, ...rest] = roma.channels
  if (channel === undefined || rest.length > 0) throw new Error('this roma has more than one Core')
  return channel.core
}

function announcedTo(spawn: { args: readonly string[] }): string {
  const at = spawn.args.indexOf('--append-system-prompt')
  return spawn.args[at + 1] ?? ''
}

afterEach(async () => {
  await teardownRoma(
    started,
    fixtures.flatMap(({ roots }) => roots),
  )
  started = []
  fixtures = []
})

describe('starting roma', () => {
  it('builds nothing that can take a message until the self-check has passed [fence:startup-nothing-before-the-self-check]', async () => {
    const roma = boot()

    await flush()
    expect(roma.hasStarted(), BEFORE_THE_CHECK).toBe(false)
    expect(roma.claude.spawns, BEFORE_THE_CHECK).toHaveLength(1)
    expect(existsSync(socketPathIn(roma.shims.dir)), BEFORE_THE_CHECK).toBe(false)

    await roma.answerProbe()
    await expect(roma.starting).resolves.toMatchObject({ core: expect.anything() })
  })

  it('refuses to start at all when the self-check fails', async () => {
    const roma = boot()

    await roma.answerProbe(STRAY_KEY)

    await expect(roma.starting).rejects.toThrow(StartupSelfCheckFailed)
    expect(roma.claude.spawns).toHaveLength(1)
  })

  it('reports what the self-check found', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({
      selfCheck: { apiKeySource: 'none', model: 'claude-sonnet-5' },
    })
  })

  it('returns a Core that serves a message on the Session its Conversation is on', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.channel.instructions).toContainEqual(
      expect.objectContaining({ kind: 'result', text: 'ok' }),
    )
  })

  it('writes an Enclosure into the directory it spawns the Session in [fence:startup-core-and-pool-share-the-work-root]', async () => {
    const why =
      'The Core and the Session Pool must be handed the same Work Root (ADR-0011, ADR-0028). ' +
      'The Core no longer asks the pool where a Session works, so their agreeing is something ' +
      'startRoma does, not something the types make impossible. Handed different ones, roma ' +
      'writes every Enclosure where no Session ever looks and reports nothing: the write ' +
      'succeeds, the Turn runs, and the answer is about a file the model could not read.'
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'what is this?',
      quotation: null,
      enclosures: [
        {
          name: 'screenshot.png',
          from: null,
          redeem: () => Promise.resolve(new TextEncoder().encode('PNG')),
        },
      ],
    })
    let session
    for (let waited = 0; waited < 5_000 && session === undefined; waited += 5) {
      await flush()
      try {
        session = roma.procFor(KEY)
      } catch {
        await sleep(5)
      }
    }
    feed(session!, OK)
    await handled

    const cwd = roma.claude.lastSpawn.cwd
    expect(existsSync(join(cwd, '.enclosures')), why).toBe(true)
    const [file] = readdirSync(join(cwd, '.enclosures'))
    expect(readFileSync(join(cwd, '.enclosures', file!), 'utf8'), why).toBe('PNG')
  })

  it.each([
    [
      '/model opus',
      (spawn: { args: readonly string[] }) => spawn.args[spawn.args.indexOf('--model') + 1],
      'claude-opus-5',
    ],
    [
      '/effort low',
      (spawn: { args: readonly string[] }) => spawn.args[spawn.args.indexOf('--effort') + 1],
      'low',
    ],
    [
      '/caveman ultra',
      (spawn: { args: readonly string[] }) => announcedTo(spawn).includes(cavemanRuleset('ultra')),
      true,
    ],
  ])(
    'lets a Conversation move what its next Turn runs on: %s [fence:startup-pool-reads-the-chosen-records]',
    async (command, read, expected) => {
      const why =
        `After \`${command}\`, the next Turn must run on what was chosen: the pool must be built ` +
        'over the same Chosen Model, Effort and Caveman records the Core writes (ADR-0014, ' +
        'ADR-0016, ADR-0030; #86, #91). Without one, roma answers the Command perfectly, writes ' +
        'a perfect record, and runs every Turn on the pinned value — and for the effort nothing ' +
        'in the stream contradicts it, because system/init carries no effort field.'
      const roma = boot()
      await roma.answerProbe()
      const { core } = await roma.starting

      await core.handle({
        conversationKey: KEY,
        caller: 'someone',
        callerName: 'Someone',
        text: command,
        enclosures: [],
        quotation: null,
      })
      const handled = core.handle({
        conversationKey: KEY,
        caller: 'someone',
        callerName: 'Someone',
        text: 'hello',
        enclosures: [],
        quotation: null,
      })
      await flush()
      const spawn = roma.claude.lastSpawn
      feed(roma.procFor(KEY), OK)
      await handled

      expect(read(spawn), why).toBe(expected)
    },
  )

  it('writes the Task down, on the credential it was started with', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    const month = monthOf(new Date())
    expect(audit.readMonth(month)).toMatchObject([
      {
        caller: 'someone',
        callerName: 'Someone',
        sessionId: sessionIdFor(KEY),
        outcome: 'result',
        credential: 'shared-window',
        apiKeySource: 'none',
      },
    ])
    expect(readdirSync(roma.auditRoot)).toEqual([`${month}.jsonl`])
  })

  it('does not record the self-check as a Task', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { audit } = await roma.starting

    expect(audit.readMonth(monthOf(new Date()))).toEqual([])
  })
})

describe('proving roma can reach the code, before anything can ask it to', () => {
  const INSTALLATION_AT_BOOT =
    'The GitHub Installation must be asked for at boot, before anything that could accept an ' +
    'Ingress Message exists, and a failure must block the boot (ADR-0008). Checked lazily, a ' +
    'bad private key surfaces as an inexplicable clone failure inside somebody’s Turn, ' +
    'which reads as "roma is broken" with no diagnosis attached.'
  it('asks for the Installation before it drives a single Turn [fence:startup-installation-proved-at-boot]', async () => {
    const roma = boot()

    await flush()

    expect(roma.minter.installations, INSTALLATION_AT_BOOT).toBe(1)
  })

  it('refuses to start at all when it cannot [fence:startup-installation-proved-at-boot]', async () => {
    const roma = boot({ minter: new FakeMinter({ failsWith: new Error('a bad private key') }) })

    await expect(roma.starting, INSTALLATION_AT_BOOT).rejects.toThrow('a bad private key')
    expect(roma.claude.spawns, INSTALLATION_AT_BOOT).toHaveLength(0)
  })

  it('reports what it found, for the boot log', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'reach', credential: 'code', account: 'a-team' })
  })

  it('never touches another provider once the free check has refused [fence:startup-reaches-proved-one-at-a-time]', async () => {
    const why =
      'startRoma must prove the Reaches one at a time, code first, never with Promise.all ' +
      '(ADR-0020 §4, #119): a boot with a bad App key must make no network call to another ' +
      'provider, and a deployment broken both ways must be told about the free check first.'
    const cloudMinter = new FakeCloudMinter()
    const roma = boot({
      minter: new FakeMinter({ failsWith: new Error('a bad private key') }),
      cloudMinter,
    })

    await expect(roma.starting, why).rejects.toThrow('a bad private key')

    expect(cloudMinter.minted, why).toEqual([])
  })
})

describe('proving the Cloud Reach before anything can ask to use it', () => {
  it('mints one Cloud Token and throws it away', async () => {
    const cloudMinter = new FakeCloudMinter()
    const roma = boot({ cloudMinter })
    await roma.answerProbe()
    await roma.starting

    expect(cloudMinter.minted).toHaveLength(1)
  })

  it('refuses to start at all when the key it was given does not work', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter({ failsWith: new Error('the key was revoked') }),
    })

    await expect(roma.starting).rejects.toThrow('the key was revoked')
    expect(roma.claude.spawns).toHaveLength(0)
  })

  it('refuses in the shape every other configuration problem arrives in', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter({
        account: 'agent@a-project.iam.gserviceaccount.com',
        failsWith: new Error('the key was revoked'),
      }),
    })

    await expect(roma.starting).rejects.toThrow(ConfigurationMissing)
    await expect(roma.starting).rejects.toThrow(/agent@a-project/)
  })

  it('starts perfectly well with no Cloud Reach at all', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({ core: expect.anything() })
  })

  it('reports which identity the agent acts as, for the boot log', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' }),
    })
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({
      event: 'reach',
      credential: 'cloud',
      account: 'agent@a-project.iam.gserviceaccount.com',
    })
  })

  it('says so at boot when there is no Cloud Reach [fence:startup-reach-line-every-boot]', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log, REACH_LINE).toContainEqual({
      event: 'reach',
      credential: 'cloud',
      account: null,
    })
  })
})

describe('proving the Document Reach before anything can ask to use it', () => {
  it('mints one Document Token, throws it away, and reaches the Depot', async () => {
    const documentMinter = new FakeDocumentMinter()
    const roma = boot({ documentMinter })
    await roma.answerProbe()
    await roma.starting

    expect(documentMinter.minted).toHaveLength(1)
    expect(documentMinter.depots).toBe(1)
  })

  it('refuses to start at all when the key it was given does not work', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({ failsWith: new Error('the key was revoked') }),
    })

    await expect(roma.starting).rejects.toThrow(ConfigurationMissing)
    await expect(roma.starting).rejects.toThrow('the key was revoked')
    expect(roma.claude.spawns).toHaveLength(0)
  })

  it('refuses to start when the Depot answers and will not take children', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({
        depotFailsWith: new Error(
          'roma can see the Depot "FOLDER_ID" and cannot add anything to it',
        ),
      }),
    })

    await expect(roma.starting).rejects.toThrow(ConfigurationMissing)
    await expect(roma.starting).rejects.toThrow(/cannot add anything to it/)
  })

  it('carries which of the three things is wrong into the refusal', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({
        depotFailsWith: new Error('roma could not find the Depot: it is "TYPD_ID"'),
      }),
    })

    await expect(roma.starting).rejects.toThrow(/TYPD_ID/)
  })

  it('starts perfectly well with no Document Reach at all', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({ core: expect.anything() })
  })

  it('reports which identity the agent writes as, for the boot log', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({
        account: 'writer@a-project.iam.gserviceaccount.com',
      }),
    })
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({
      event: 'reach',
      credential: 'documents',
      account: 'writer@a-project.iam.gserviceaccount.com',
    })
  })

  it('says so at boot when there is no Document Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'reach', credential: 'documents', account: null })
  })

  it('records a mint of a Document Token, and not the asks it served from cache', async () => {
    const documentMinter = new FakeDocumentMinter({
      account: 'writer@a-project.iam.gserviceaccount.com',
    })
    const roma = boot({ documentMinter })
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.shims.dir)
    const ask = () =>
      askMinter(socket, { session: sessionIdFor(KEY), operation: 'get', credential: 'documents' })

    await ask()
    await ask()

    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted' && r.credential === 'documents'),
    ).toEqual([
      {
        event: 'reach-token-minted',
        credential: 'documents',
        account: 'writer@a-project.iam.gserviceaccount.com',
      },
    ])
  })
})

describe('serving three credentials over one socket', () => {
  it('answers each request with its own Reach’s token and account [fence:startup-one-fresh-tokens-per-reach]', async () => {
    const why =
      'Each Reach must be served from a FreshTokens of its own, never one shared (#99, ' +
      'ADR-0020 §3): they hold different credentials with different expiries, and a shared one ' +
      'hands a Drive request a cloud-platform token — everything looks fine until the first call.'
    const cloudMinter = new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' })
    const documentMinter = new FakeDocumentMinter({
      account: 'writer@a-project.iam.gserviceaccount.com',
    })
    const roma = boot({ cloudMinter, documentMinter })
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.shims.dir)
    const asking = { session: sessionIdFor(KEY), operation: 'get' } as const

    const code = await askMinter(socket, asking)
    const cloud = await askMinter(socket, { ...asking, credential: 'cloud' })
    const documents = await askMinter(socket, { ...asking, credential: 'documents' })

    expect(code.token, why).toMatch(/^token-/)
    expect(code.account, why).toBe('a-team')
    expect(cloud.token, why).toMatch(/^cloud-token-/)
    expect(cloud.account, why).toBe('agent@a-project.iam.gserviceaccount.com')
    expect(documents.token, why).toMatch(/^document-token-/)
    expect(documents.account, why).toBe('writer@a-project.iam.gserviceaccount.com')
  })

  it('answers a documents request with a sentence where there is no Document Reach', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    await roma.starting

    const answer = await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'documents',
    })

    expect(answer.token).toBeNull()
    expect(answer.reason).toContain('no Document Reach')
  })
})

describe('telling a Session about the documents', () => {
  it('names the Document Reach in the system prompt, beside the other two', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter(),
      documentMinter: new FakeDocumentMinter({
        account: 'writer@a-project.iam.gserviceaccount.com',
      }),
    })
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toContain('reaches a-team/roma')
    expect(announcedTo(spawn)).toContain('acts as agent@a-project.iam.gserviceaccount.com')
    expect(announcedTo(spawn)).toContain('writes as writer@a-project.iam.gserviceaccount.com')
  })

  it('says nothing about documents where there is no Document Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toBe('reaches a-team/roma')
  })
})

describe('whether a Task used the Document Reach', () => {
  it('is written on the Audit Record of the Task that obtained one', async () => {
    const roma = boot({ documentMinter: new FakeDocumentMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'documents',
    })
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ documentReach: true }])
  })

  it('is not written for a Task that only asked for the cloud', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter(),
      documentMinter: new FakeDocumentMinter(),
    })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'cloud',
    })
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([
      { cloudReach: true, documentReach: false },
    ])
  })

  it('is written as no for a Task that never asked', async () => {
    const roma = boot({ documentMinter: new FakeDocumentMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ documentReach: false }])
  })
})

describe('watching for a mint storm', () => {
  it('records the mint, and does not record the asks it served from cache', async () => {
    const cloudMinter = new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' })
    const roma = boot({ cloudMinter })
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.shims.dir)
    const ask = () =>
      askMinter(socket, { session: sessionIdFor(KEY), operation: 'get', credential: 'cloud' })

    await ask()
    await ask()
    await ask()

    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted' && r.credential === 'cloud'),
    ).toEqual([
      {
        event: 'reach-token-minted',
        credential: 'cloud',
        account: 'agent@a-project.iam.gserviceaccount.com',
      },
    ])
  })

  it('records a mint for the forge as well, which it never used to', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.shims.dir)

    await askMinter(socket, { session: sessionIdFor(KEY), operation: 'get' })
    await askMinter(socket, { session: sessionIdFor(KEY), operation: 'get' })

    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted' && r.credential === 'code'),
    ).toEqual([{ event: 'reach-token-minted', credential: 'code', account: 'a-team' }])
  })

  it('does not count the mint that proved the key at boot [fence:startup-reach-line-every-boot]', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    await roma.starting

    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted'),
      REACH_LINE,
    ).toEqual([])
    expect(
      roma.log.filter((r) => r.event === 'reach').map((r) => r.credential),
      REACH_LINE,
    ).toEqual(['code', 'cloud', 'documents'])
  })
})

describe('telling a Session about the cloud', () => {
  it('names the Cloud Reach in the system prompt, beside what it can reach on the forge', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' }),
    })
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toContain('reaches a-team/roma')
    expect(announcedTo(spawn)).toContain('acts as agent@a-project.iam.gserviceaccount.com')
  })

  it('says nothing about the cloud where there is no Cloud Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toBe('reaches a-team/roma')
  })
})

function everyFileIn(roots: readonly string[]): { path: string; text: string }[] {
  return roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((name) => join(root, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => ({ path, text: readFileSync(path, 'utf8') })),
  )
}

describe('where a Cloud Token may be', () => {
  it('is in no Session’s environment and in no file roma keeps [fence:startup-cloud-token-is-asked-for-never-kept]', async () => {
    const why =
      'A Cloud Token is obtained when a command asks the socket for one, and is never written ' +
      'into a process environment fixed at spawn nor persisted anywhere that outlives that ' +
      'command (ADR-0015 §3, ADR-0008). An environment is fixed at spawn and would be stale ' +
      'within the hour while a Resident Session outliving an hour is ordinary; and a token in ' +
      'an environment or a file is one `env` or `cat` away from a Transcript roma never deletes.'
    const cloudMinter = new FakeCloudMinter()
    const roma = boot({ cloudMinter })
    await roma.answerProbe()
    const { core } = await roma.starting

    const served = await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'cloud',
    })
    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    const tokens = cloudMinter.minted.map(({ token }) => token)
    expect(tokens, why).toContain(served.token)
    for (const token of tokens) {
      expect(
        Object.entries(env).filter(([, value]) => value.includes(token)),
        why,
      ).toEqual([])
      expect(
        everyFileIn(roma.roots)
          .filter(({ text }) => text.includes(token))
          .map(({ path }) => path),
        why,
      ).toEqual([])
    }
  })
})

describe('whether a Task used the Cloud Reach', () => {
  it('is written on the Audit Record of the Task that obtained one', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'cloud',
    })
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ cloudReach: true }])
  })

  it('is not written for a Task that only asked for the forge', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    await askMinter(socketPathIn(roma.shims.dir), {
      session: sessionIdFor(KEY),
      operation: 'get',
    })
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ cloudReach: false }])
  })

  it('is written as no for a Task that never asked', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ cloudReach: false }])
  })
})

describe('putting a credential in front of a Session’s tools', () => {
  it('tells every Session what it can reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toBe('reaches a-team/roma')
  })

  it('tells every Session where to ask for a credential, and who is asking', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(env['ROMA_SESSION_ID']).toBe(sessionIdFor(KEY))
    expect(env['ROMA_MINTER_SOCKET']).toBe(socketPathIn(roma.shims.dir))
    expect(env['GIT_CONFIG_GLOBAL']).toBe(join(roma.shims.dir, 'gitconfig'))
  })

  it('keeps the socket and the gitconfig in a directory of roma’s own [fence:startup-shim-dir-is-roma-own]', async () => {
    const why =
      'The Shim socket and the gitconfig must live in roma’s own directory, never under the ' +
      'work root or in a Working Directory (#62). The work root is reclaimed after seven idle ' +
      'days, and a reclaimed socket fails every credential request in roma at once with no ' +
      'explanation; a Working Directory is where the agent runs `git add -A`.'
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(existsSync(socketPathIn(roma.shims.dir)), why).toBe(true)
    expect(readFileSync(join(roma.shims.dir, 'gitconfig'), 'utf8'), why).toBe(roma.shims.gitConfig)
    expect(readdirSync(roma.workRoot), why).toEqual([])
  })

  it('puts no credential for the forge in any Session’s environment [fence:startup-no-forge-token-in-env]', async () => {
    const why =
      'No token for the forge may be minted into a Session’s environment (ADR-0008). An ' +
      'environment is fixed at spawn while a Resident Session outlives the hour the token ' +
      'lasts, and `env`, a stack trace or a diagnostic command would write it into a ' +
      'Transcript roma has promised never to delete (ADR-0006).'
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.minter.minted, why).toEqual([])
    expect(Object.keys(env), why).not.toContain('GH_TOKEN')
  })
})

describe('telling a Session how short to be', () => {
  async function appendUnder(caveman?: string): Promise<string> {
    const roma = boot(caveman === undefined ? {} : { caveman })
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    return announcedTo(spawn)
  }

  it.each([...CAVEMAN_MENU, ...OFF_MENU_WENYAN].filter((level) => level !== CAVEMAN_OFF))(
    'carries the ruleset for %s into the spawn arguments',
    async (level) => {
      expect(await appendUnder(level)).toContain(cavemanRuleset(level))
    },
  )

  it('puts it after whatever the Reaches had to say', async () => {
    expect(await appendUnder('ultra')).toBe(`reaches a-team/roma\n\n${cavemanRuleset('ultra')}`)
  })

  it('says nothing at all where the Caveman is off', async () => {
    expect(await appendUnder(CAVEMAN_OFF)).toBe('reaches a-team/roma')
  })

  it('leaves a deployment that named no Caveman byte-identical to before', async () => {
    expect(await appendUnder()).toBe('reaches a-team/roma')
  })

  async function recordUnder(caveman?: string): Promise<AuditRecord | undefined> {
    const roma = boot(caveman === undefined ? {} : { caveman })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
      quotation: null,
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    return audit.readMonth(monthOf(new Date())).at(0)
  }

  it('writes down that nothing named a Caveman, and tells that from pinning off', async () => {
    expect(await recordUnder()).toMatchObject({ caveman: CAVEMAN_NOT_PINNED })
    expect(await recordUnder(CAVEMAN_OFF)).toMatchObject({ caveman: CAVEMAN_OFF })
    expect(await recordUnder('ultra')).toMatchObject({ caveman: 'ultra' })
  })

  it('writes down what the Turn produced, as the Turn’s own delta', async () => {
    expect(await recordUnder('ultra')).toMatchObject({ outputTokens: 17 })
  })
})

function bootChannels({
  channels = 2,
  maxConcurrentTasks,
}: { channels?: number; maxConcurrentTasks?: number } = {}) {
  const fixture = romaFixture('startup')
  fixtures.push(fixture)
  const shims = fakeShims()
  fixture.alsoRemove(shims.dir)
  const adapters = Array.from({ length: channels }, () => new RecordingAdapter())
  const built = { cores: 0 }
  const bindings: ChannelBinding[] = adapters.map((adapter) => {
    const binding = bind(adapter, new FakeTransport())
    return {
      coreOver: (build) => {
        built.cores += 1
        return binding.coreOver(build)
      },
    }
  })
  const starting = startRoma({
    credential: OAUTH,
    channels: bindings,
    ...fixture.dirs,
    reaches: fakeReaches(),
    shims,
    spawn: fixture.claude.spawn,
    log: () => {},
    selfCheckTimeoutMs: 1_000,
    ...(maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks }),
  }).then((roma) => {
    started.push(roma)
    return roma
  })
  starting.catch(() => {})
  return { fixture, shims, adapters, built, starting }
}

function said(conversationKey: string, text = 'hello') {
  return {
    conversationKey,
    caller: 'someone',
    callerName: 'Someone',
    text,
    enclosures: [],
    quotation: null,
  }
}

describe('what a roma serving several Channels is made of', () => {
  it('binds no Channel and serves no credential when the self-check refuses [fence:startup-nothing-before-the-self-check]', async () => {
    const roma = bootChannels()

    await roma.fixture.answerProbe(STRAY_KEY)

    await expect(roma.starting, BEFORE_THE_CHECK).rejects.toThrow(StartupSelfCheckFailed)
    expect(roma.built.cores, BEFORE_THE_CHECK).toBe(0)
    expect(existsSync(socketPathIn(roma.shims.dir)), BEFORE_THE_CHECK).toBe(false)
  })

  it('answers each Channel’s messages on that Channel [fence:startup-each-core-on-its-own-channel]', async () => {
    const why =
      'Each Core must be built over its own binding’s Adapter, never handed to a binding ready ' +
      'made (ADR-0028): a Core paired with the wrong Channel answers every message into ' +
      'somebody else’s product, and nothing downstream of startRoma can tell.'
    const roma = bootChannels()
    await roma.fixture.answerProbe()
    const { channels } = await roma.starting

    for (const [index, { core }] of channels.entries()) {
      const key = `conversation-${index}`
      const handled = core.handle(said(key))
      await flush()
      feed(roma.fixture.procFor(key), OK)
      await handled
    }

    for (const [index, adapter] of roma.adapters.entries()) {
      expect(
        new Set(adapter.instructions.map(({ conversationKey }) => conversationKey)),
        why,
      ).toEqual(new Set([`conversation-${index}`]))
      expect(
        adapter.instructions.some(({ kind }) => kind === 'result'),
        why,
      ).toBe(true)
    }
  })

  it('holds one concurrency cap across every Channel [fence:startup-one-queue-for-every-channel]', async () => {
    const roma = bootChannels({ maxConcurrentTasks: 1 })
    await roma.fixture.answerProbe()
    const { channels } = await roma.starting
    const [first, second] = channels

    const one = first!.core.handle(said('on-the-first'))
    await flush()
    const two = second!.core.handle(said('on-the-second'))
    await flush()

    expect(roma.fixture.claude.spawns, ONE_OF_EVERYTHING).toHaveLength(2)

    feed(roma.fixture.procFor('on-the-first'), OK)
    await one
    await flush()
    feed(roma.fixture.procFor('on-the-second'), OK)
    await two
  })

  it('moves a Conversation for every Channel when one Channel clears it [fence:startup-one-session-record-for-every-channel]', async () => {
    const why =
      'Every Core must read and write the one SessionGenerations record startRoma builds over ' +
      'the pool’s Work Root (ADR-0028, ADR-0013). A Conversation two Cores each kept their own ' +
      'answer for is two Conversations: the `/clear` said on one Channel is never heard by the ' +
      'other, which goes on sending the same Conversation Key to the Session that was cleared.'
    const roma = bootChannels()
    await roma.fixture.answerProbe()
    const { channels } = await roma.starting
    const [first, second] = channels

    await first!.core.handle(said(KEY, '/clear'))
    const handled = second!.core.handle(said(KEY))
    await flush()
    const spawn = roma.fixture.claude.lastSpawn
    feed(roma.fixture.procIn(sessionIdFor(KEY, 1)), OK)
    await handled

    expect(spawn.cwd, why).toBe(join(roma.fixture.dirs.workRoot, sessionIdFor(KEY, 1)))
  })

  it('stops serving credentials however the pool’s shutdown went [fence:startup-socket-closed-whatever-the-pool-did]', async () => {
    const why =
      'Shutdown must close the Shim socket in a finally, whatever the pool’s own shutdown did ' +
      '(#62): a socket left listening on a roma that is otherwise gone is a credential still ' +
      'being served to nothing.'
    const roma = bootChannels({ channels: 1 })
    await roma.fixture.answerProbe()
    const running = await roma.starting
    const shutdown = running.pool.shutdown.bind(running.pool)
    running.pool.shutdown = () => Promise.reject(new Error('the pool could not stop'))

    try {
      await expect(running.shutdown()).rejects.toThrow('the pool could not stop')
    } finally {
      running.pool.shutdown = shutdown
    }

    expect(existsSync(socketPathIn(roma.shims.dir)), why).toBe(false)
    await expect(
      askMinter(socketPathIn(roma.shims.dir), { session: 'anyone', operation: 'get' }),
      why,
    ).rejects.toThrow()
  })

  it('serves credentials until the processes have stopped [fence:startup-socket-closed-after-the-processes]', async () => {
    const why =
      'Shutdown must close the Shim socket after the pool has stopped its processes, never ' +
      'before (#62, ADR-0008): a Session being killed can still have a `git` mid-operation, and ' +
      'taking the credential away first turns a clean shutdown into authentication failures in ' +
      'somebody’s Transcript.'
    const roma = bootChannels({ channels: 1 })
    await roma.fixture.answerProbe()
    const running = await roma.starting
    const shutdown = running.pool.shutdown.bind(running.pool)
    let askedWhileStopping: Promise<unknown> | undefined
    running.pool.shutdown = async () => {
      askedWhileStopping = askMinter(socketPathIn(roma.shims.dir), {
        session: 'anyone',
        operation: 'get',
      })
      await askedWhileStopping.catch(() => undefined)
      await shutdown()
    }

    await running.shutdown()

    await expect(askedWhileStopping, why).resolves.toBeDefined()
  })
})

describe('what startRoma will not be started without', () => {
  it('requires the audit root and the Claude config dir [fence:startup-durable-paths-are-required]', () => {
    const why =
      'auditRoot and configDir must stay required on StartRomaOptions, never defaulted (#28, ' +
      '#37). An audit root defaulted under workRoot is deleted by the seven-day reclaim, and ' +
      'the Audit Records are the only record of who spent what; an unnamed config dir sends ' +
      'credential resolution to the host keychain and Transcripts into the host ~/.claude.'
    const without = (options: StartRomaOptions) => {
      const { auditRoot: _audit, ...noAuditRoot } = options
      const { configDir: _config, ...noConfigDir } = options
      // @ts-expect-error -- fence:startup-durable-paths-are-required
      const a: StartRomaOptions = noAuditRoot
      // @ts-expect-error -- fence:startup-durable-paths-are-required
      const b: StartRomaOptions = noConfigDir
      return [a, b]
    }

    expect(typeof without, why).toBe('function')
  })

  it('requires every Reach by name [fence:startup-every-reach-is-named]', () => {
    const why =
      'StartRomaOptions.reaches must name every Reach, code first among them (#119, ADR-0020 ' +
      '§3): a roma with no code Reach proves no key, announces nothing and fails every git ' +
      'request inside somebody’s Turn — the failure blocking the boot exists to prevent.'
    const { code: _code, ...noCode } = fakeReaches()
    // @ts-expect-error -- fence:startup-every-reach-is-named
    const reaches: Reaches = noCode

    expect(Object.keys(reaches).sort(), why).toEqual(['cloud', 'documents'])
  })
})
