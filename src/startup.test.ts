import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { monthOf } from './audit-log.js'
import type { Credential } from './build-env.js'
import { ConfigurationMissing } from './env-config.js'
import { sessionIdFor } from './session-id.js'
import { askMinter } from './shim-client.js'
import { socketPathIn } from './shim-protocol.js'
import { startRoma, type Roma } from './startup.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import { flush } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import {
  fakeCloud,
  fakeMinting,
  FakeCloudMinter,
  FakeMinter,
} from '../test/support/fake-minter.js'
import type { CloudLogRecord } from './startup.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../test/support/roma-fixture.js'
import { feed, OK, STRAY_KEY } from '../test/support/recorded-stream.js'

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'token' }
const KEY = 'conversation-one'

let started: Roma[] = []
let fixtures: RomaFixture[] = []

function boot({
  minter = new FakeMinter(),
  cloudMinter,
}: {
  minter?: FakeMinter
  /** Omitted, this roma has no Cloud Reach — which is the ordinary deployment. */
  cloudMinter?: FakeCloudMinter
} = {}) {
  const fixture = romaFixture('startup')
  fixtures.push(fixture)
  const minting = fakeMinting({ minter })
  const cloud = cloudMinter === undefined ? undefined : fakeCloud({ minter: cloudMinter })
  fixture.alsoRemove(minting.shimDir)
  const channel = new RecordingAdapter()
  const log: CloudLogRecord[] = []

  let resolved = false
  const starting = startRoma({
    credential: OAUTH,
    channel,
    ...fixture.dirs,
    minting,
    ...(cloud === undefined ? {} : { cloud }),
    spawn: fixture.claude.spawn,
    log: (record) => log.push(record as CloudLogRecord),
    selfCheckTimeoutMs: 1_000,
  }).then((roma) => {
    resolved = true
    started.push(roma)
    return roma
  })

  return {
    claude: fixture.claude,
    channel,
    workRoot: fixture.dirs.workRoot,
    auditRoot: fixture.dirs.auditRoot,
    minter,
    cloudMinter,
    minting,
    log,
    starting,
    hasStarted: () => resolved,
    answerProbe: fixture.answerProbe,
    procFor: fixture.procFor,
  }
}

/** What one Session was appended to its system prompt. */
function announcedTo(spawn: { args: readonly string[] }): string {
  const at = spawn.args.indexOf('--append-system-prompt')
  return spawn.args[at + 1] ?? ''
}

afterEach(async () => {
  await teardownRoma(started, fixtures.flatMap(({ roots }) => roots))
  started = []
  fixtures = []
})

describe('starting roma', () => {
  // The acceptance criterion, in the only form it can take: there is nothing to
  // accept an ingress message with until the self-check has passed, because the
  // Core that would accept one does not exist yet.
  it('builds nothing that can take a message until the self-check has passed', async () => {
    const roma = boot()

    await flush()
    expect(roma.hasStarted()).toBe(false)
    // One process, and it is the probe. No Session has been spawned, because
    // nothing has been able to ask for one.
    expect(roma.claude.spawns).toHaveLength(1)

    await roma.answerProbe()
    await expect(roma.starting).resolves.toMatchObject({ core: expect.anything() })
  })

  it('refuses to start at all when the self-check fails', async () => {
    const roma = boot()

    await roma.answerProbe(STRAY_KEY)

    await expect(roma.starting).rejects.toThrow(StartupSelfCheckFailed)
    // Still just the probe: a boot that failed leaves nothing running and
    // nothing for a message to arrive at.
    expect(roma.claude.spawns).toHaveLength(1)
  })

  it('reports what the self-check found', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({
      selfCheck: { apiKeySource: 'none', model: 'claude-sonnet-5' },
    })
  })

  // Wiring, asserted the only way that means anything: a message goes in and the
  // Channel is asked to post the answer.
  it('returns a Core that serves a message on the Session its Conversation is on', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.channel.instructions).toContainEqual(
      expect.objectContaining({ kind: 'result', text: 'ok' }),
    )
  })

  // The ADR-0014 half of that wiring. The Core writes a Chosen Model down and
  // the pool reads it at the next spawn, so `/model` means something only if
  // `startRoma` hands the record to the pool at all. Left out, roma answers
  // `/model` perfectly, writes a perfect file, and runs every Turn on the Pinned
  // Model — a failure with no symptom at either end taken on its own.
  //
  // What this does not catch, said so that nobody reads more into it:
  // `ChosenModels` holds nothing between calls, so a second instance beside the
  // first is the same object in every way that matters, and one built over the
  // *wrong* work root is invisible here because the Core and the pool would
  // agree about the wrong place. That the record lands beside the generations is
  // `session-pool.test.ts`'s reclaim test.
  it('lets a Conversation move the model its next Turn runs on', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    await core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: '/model opus',
      enclosures: [],
    })
    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
      enclosures: [],
    })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.claude.lastSpawn.args).toContain('claude-opus-5')
  })

  // The other half of that wiring, and the half nothing else would notice was
  // missing: a roma whose audit log was not connected answers every message
  // perfectly and records nobody's spending, which cannot be reconstructed
  // afterwards because the provider never knew who anyone was.
  it('writes the Task down, on the credential it was started with', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    feed(roma.procFor(KEY), OK)
    await handled

    const month = monthOf(new Date())
    expect(audit.readMonth(month)).toMatchObject([
      {
        caller: 'someone', callerName: 'Someone',
        sessionId: sessionIdFor(KEY),
        outcome: 'result',
        credential: 'shared-window',
        apiKeySource: 'none',
      },
    ])
    // Under a directory of its own rather than the Session Pool's work root,
    // which is walked by a reclaim that deletes what has gone a week untouched.
    expect(readdirSync(roma.auditRoot)).toEqual([`${month}.jsonl`])
  })

  // The probe Turn is roma's own, driven before anything can accept a message,
  // and there is no Task and no caller to attribute it to. Recording it would
  // put a Task in the log that nobody sent.
  it('does not record the self-check as a Task', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { audit } = await roma.starting

    expect(audit.readMonth(monthOf(new Date()))).toEqual([])
  })
})

describe('proving roma can reach the code, before anything can ask it to', () => {
  // Free, unlike the Claude one, and asked first for that reason: a deployment
  // that is wrong in both ways is told about the cheap problem without having
  // paid for a Turn to find out about the other.
  it('asks for the Installation before it drives a single Turn', async () => {
    const roma = boot()

    await flush()

    expect(roma.minter.installations).toBe(1)
  })

  // The Startup Self-Check's shape, for the Startup Self-Check's reason. A bad
  // private key surfacing instead as an inexplicable `git clone` failure inside
  // somebody's Turn would read as "roma is broken" with no diagnosis attached.
  it('refuses to start at all when it cannot', async () => {
    const roma = boot({ minter: new FakeMinter({ failsWith: new Error('a bad private key') }) })

    await expect(roma.starting).rejects.toThrow('a bad private key')
    // Not one process. The paid check never ran, because the free one had
    // already answered.
    expect(roma.claude.spawns).toHaveLength(0)
  })

  it('reports what it found, for the boot log', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({
      installation: { account: 'a-team', repositories: ['a-team/roma'] },
    })
  })
})

describe('proving the Cloud Reach before anything can ask to use it', () => {
  // Not by parsing the key, because a syntactically perfect key can be revoked
  // — the Startup Self-Check's blind spot in Google's colours, and here the real
  // invocation is nearly free: no Turn, no model, no money.
  it('mints one Cloud Token and throws it away', async () => {
    const cloudMinter = new FakeCloudMinter()
    const roma = boot({ cloudMinter })
    await roma.answerProbe()
    await roma.starting

    expect(cloudMinter.minted).toHaveLength(1)
  })

  // Story 13, and the whole of §8: a key that exists and does not work stops the
  // boot, so it is learned about at boot rather than from a confused agent
  // mid-Task.
  it('refuses to start at all when the key it was given does not work', async () => {
    const roma = boot({
      cloudMinter: new FakeCloudMinter({ failsWith: new Error('the key was revoked') }),
    })

    await expect(roma.starting).rejects.toThrow('the key was revoked')
    // Not one process. The paid check never ran, because the free one had
    // already answered.
    expect(roma.claude.spawns).toHaveLength(0)
  })

  // Reported in the shape everything else wrong with the configuration is
  // reported in, so that standing roma up stays one pass. It also names the
  // identity, because "which account" is the first thing anybody reading this
  // needs.
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

  // A deployment with no Cloud Reach pays nothing for the feature, which is
  // story 17 and the reason the whole thing is optional.
  it('starts perfectly well with no Cloud Reach at all', async () => {
    const roma = boot()
    await roma.answerProbe()

    await expect(roma.starting).resolves.toMatchObject({ cloudReach: null })
  })

  it('reports which identity the agent acts as, for the boot log', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' }) })
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({
      event: 'cloud-reach',
      account: 'agent@a-project.iam.gserviceaccount.com',
    })
  })

  // Written on the boots with nothing to say as well, so that which deployment
  // an operator is looking at can be read off the log rather than inferred from
  // a line that is not there — which would mean two things at once.
  it('says so at boot when there is no Cloud Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'cloud-reach', account: null })
  })
})

describe('watching for a mint storm', () => {
  // Story 21. The credential line beside this one is written per *request*, and
  // the Cloud Shortcut asks on every invocation by design — so a log that
  // counted asks would make a loop that is minting and a busy hour that is
  // being served from cache look identical, which is the one thing an operator
  // is watching for.
  it('records the mint, and does not record the asks it served from cache', async () => {
    const cloudMinter = new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' })
    const roma = boot({ cloudMinter })
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.minting.shimDir)
    const ask = () =>
      askMinter(socket, { session: sessionIdFor(KEY), operation: 'get', credential: 'cloud' })

    await ask()
    await ask()
    await ask()

    expect(roma.log.filter(({ event }) => event === 'cloud-token-minted')).toEqual([
      { event: 'cloud-token-minted', account: 'agent@a-project.iam.gserviceaccount.com' },
    ])
  })

  // The boot proof mints too, and is deliberately not one of these: it was never
  // served to anybody, and counting it would put a standing +1 on every
  // deployment's mint rate. The `cloud-reach` line is its record.
  it('does not count the mint that proved the key at boot', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    await roma.starting

    expect(roma.log.filter(({ event }) => event === 'cloud-token-minted')).toEqual([])
  })
})

describe('telling a Session about the cloud', () => {
  // Discovery has to be free or the Shortcut defeats itself: a `--help` is a
  // Turn, a Session remembers nothing, and that is a Turn paid once per Session
  // to save Turns.
  it('names the Cloud Reach in the system prompt, beside what it can reach on the forge', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' }) })
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toContain('reaches a-team/roma')
    expect(announcedTo(spawn)).toContain('acts as agent@a-project.iam.gserviceaccount.com')
  })

  // A paragraph about a capability that is not there is worse than silence: the
  // agent would attempt the work and report a command that does not exist.
  it('says nothing about the cloud where there is no Cloud Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(announcedTo(spawn)).toBe('reaches a-team/roma')
  })
})

describe('whether a Task used the Cloud Reach', () => {
  // The whole chain, from the only place all of it is visible: something in the
  // agent's userland asks the socket mid-Task, and the line roma writes when the
  // Task ends says so. What it is for is the Google Cloud bill — everything the
  // agent does there is one service account, so unexplained activity on it can
  // be narrowed to the people whose Tasks touched it, and nowhere else answers
  // that.
  it('is written on the Audit Record of the Task that obtained one', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    await askMinter(socketPathIn(roma.minting.shimDir), {
      session: sessionIdFor(KEY),
      operation: 'get',
      credential: 'cloud',
    })
    feed(roma.procFor(KEY), OK)
    await handled

    expect(audit.readMonth(monthOf(new Date()))).toMatchObject([{ cloudReach: true }])
  })

  // A yes and a no, not a yes and a blank. A Task that never touched the cloud
  // has to say so, or the field cannot be read as an answer at all.
  it('is written as no for a Task that never asked', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(env['ROMA_SESSION_ID']).toBe(sessionIdFor(KEY))
    expect(env['ROMA_MINTER_SOCKET']).toBe(socketPathIn(roma.minting.shimDir))
    expect(env['GIT_CONFIG_GLOBAL']).toBe(join(roma.minting.shimDir, 'gitconfig'))
  })

  // Not under the work root, which is walked by a reclaim that deletes what has
  // gone a week untouched — a reclaimed socket would present as every credential
  // request in roma failing at once, with no explanation. Not inside a Working
  // Directory either: the agent runs `git add -A` in one of those.
  it('keeps the socket and the gitconfig in a directory of roma’s own', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(existsSync(socketPathIn(roma.minting.shimDir))).toBe(true)
    expect(readFileSync(join(roma.minting.shimDir, 'gitconfig'), 'utf8')).toBe(
      roma.minting.gitConfig,
    )
    expect(readdirSync(roma.workRoot)).toEqual([])
  })

  // The one thing that must never be in a process environment. It expires within
  // the hour, and a Resident Session outliving an hour is ordinary — and `env` in
  // a Turn would write it into a Transcript roma has promised never to delete.
  it('puts no credential for the forge in any Session’s environment', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [] })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.minter.minted).toEqual([])
    expect(Object.keys(env)).not.toContain('GH_TOKEN')
  })
})
