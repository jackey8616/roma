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
  /** Omitted, this roma has no Cloud Reach — which is the ordinary deployment. */
  cloudMinter?: FakeCloudMinter
  /** Omitted, this roma has no Document Reach — also the ordinary deployment. */
  documentMinter?: FakeDocumentMinter
  /** Omitted, this roma has no Pinned Caveman — also the ordinary deployment. */
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
    // One Channel, and a Transport it will never be asked to deliver over:
    // `startRoma` builds the Cores and subscribes nothing, and `bind` is the
    // only way a Channel gets in.
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
    // The one Channel's Core, put back where every test below already looks for
    // it. A roma serving two would have two, and this fixture binds one.
    return { ...roma, core: onlyCore(roma) }
  })
  // Attached now rather than by whichever test awaits it. Answering the probe
  // takes two exchanges since ADR-0016 — the Turn, then the relayed `/effort
  // current` — so a boot that refuses on the first one rejects while the fixture
  // is still between them, and every test of a refusal would otherwise report an
  // unhandled rejection alongside its perfectly good assertion.
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
    /** Every directory this roma was given, the Shim directory included. */
    roots: fixture.roots,
  }
}

/** The Core of a roma that has exactly one Channel, which every test here does. */
function onlyCore(roma: Roma) {
  const [channel, ...rest] = roma.channels
  if (channel === undefined || rest.length > 0) throw new Error('this roma has more than one Core')
  return channel.core
}

/** What one Session was appended to its system prompt. */
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
  // The acceptance criterion, in the only form it can take: there is nothing to
  // accept an ingress message with until the self-check has passed, because the
  // Core that would accept one does not exist yet.
  it('builds nothing that can take a message until the self-check has passed [fence:startup-nothing-before-the-self-check]', async () => {
    const roma = boot()

    await flush()
    expect(roma.hasStarted(), BEFORE_THE_CHECK).toBe(false)
    // One process, and it is the probe. No Session has been spawned, because
    // nothing has been able to ask for one.
    expect(roma.claude.spawns, BEFORE_THE_CHECK).toHaveLength(1)
    expect(existsSync(socketPathIn(roma.shims.dir)), BEFORE_THE_CHECK).toBe(false)

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

  /**
   * Asserted here rather than in `core.test.ts`, where the harness hands one
   * object to both and divergence is unreachable without editing the harness.
   * This is the composition root, so this is where the agreement is made and the
   * only place it can be broken.
   */
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
          // The ordinary case since ADR-0021: the Caller attached it themselves,
          // so the Caller Marker above the message already names them.
          from: null,
          redeem: () => Promise.resolve(new TextEncoder().encode('PNG')),
        },
      ],
    })
    // The Enclosure is written before the spawn and that is real filesystem
    // work, so this waits on elapsed time rather than counting `flush`es — a
    // count of event-loop turns is not a duration, and under a loaded machine
    // the turns run out before the write lands. Waited on by asking for the
    // Session's own process rather than by counting spawns, because the probe
    // has already spawned once by the time any of this runs.
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

  // The ADR-0014 half of that wiring. The Core writes a Chosen Model down and
  // the pool reads it at the next spawn, so `/model` means something only if
  // `startRoma` hands the record to the pool at all. Left out, roma answers
  // `/model` perfectly, writes a perfect file, and runs every Turn on the Pinned
  // Model — a failure with no symptom at either end taken on its own.
  //
  // What this does not catch, said so that nobody reads more into it:
  // `ChosenRecord` holds nothing between calls, so a second instance beside the
  // first is the same object in every way that matters, and one built over the
  // *wrong* work root is invisible here because the Core and the pool would
  // agree about the wrong place. That the record lands beside the generations is
  // `session-pool.test.ts`'s reclaim test.
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

  // The other half of that wiring, and the half nothing else would notice was
  // missing: a roma whose audit log was not connected answers every message
  // perfectly and records nobody's spending, which cannot be reconstructed
  // afterwards because the provider never knew who anyone was.
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
    // Under a directory of its own rather than the Work Root,
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
  const INSTALLATION_AT_BOOT =
    'The GitHub Installation must be asked for at boot, before anything that could accept an ' +
    'Ingress Message exists, and a failure must block the boot (ADR-0008). Checked lazily, a ' +
    'bad private key surfaces as an inexplicable clone failure inside somebody’s Turn, ' +
    'which reads as "roma is broken" with no diagnosis attached.'
  // Free, unlike the Claude one, and asked first for that reason: a deployment
  // that is wrong in both ways is told about the cheap problem without having
  // paid for a Turn to find out about the other.
  it('asks for the Installation before it drives a single Turn [fence:startup-installation-proved-at-boot]', async () => {
    const roma = boot()

    await flush()

    expect(roma.minter.installations, INSTALLATION_AT_BOOT).toBe(1)
  })

  // The Startup Self-Check's shape, for the Startup Self-Check's reason. A bad
  // private key surfacing instead as an inexplicable `git clone` failure inside
  // somebody's Turn would read as "roma is broken" with no diagnosis attached.
  it('refuses to start at all when it cannot [fence:startup-installation-proved-at-boot]', async () => {
    const roma = boot({ minter: new FakeMinter({ failsWith: new Error('a bad private key') }) })

    await expect(roma.starting, INSTALLATION_AT_BOOT).rejects.toThrow('a bad private key')
    // Not one process. The paid check never ran, because the free one had
    // already answered.
    expect(roma.claude.spawns, INSTALLATION_AT_BOOT).toHaveLength(0)
  })

  // On the log rather than on what `startRoma` returns. Nothing read the returned
  // value — not a Channel, not the composition root — so ADR-0020 deleted it and
  // gave the forge the boot line it had never had. The repository list is not
  // here: `ReachProof` carries the account and the announcement carries the rest,
  // which is the half of that trade the ADR names as a loss.
  it('reports what it found, for the boot log', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'reach', credential: 'code', account: 'a-team' })
  })

  // The order used to be enforced by data flow — two statements, one after the
  // other — and a loop is where that is lost. `Promise.all` over the Reaches
  // compiles and reads as the natural generic form, and this is the only thing
  // that would notice: a boot with a bad App key must not reach a second provider
  // at all (ADR-0020 §4).
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

  // Written on the boots with nothing to say as well, so that which deployment
  // an operator is looking at can be read off the log rather than inferred from
  // a line that is not there — which would mean two things at once.
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

/**
 * The Document Reach at the seam it is worth seeing from (ADR-0022's spec).
 *
 * No new seam for a third Reach, which is the payoff ADR-0020 was cashing: a
 * Reach's whole observable behaviour already has a home, and this one lands in
 * it rather than beside it. What is asserted here is what a person could notice
 * — whether roma booted or refused and what the refusal said, what went on the
 * Operator Log, what the socket answered, what landed on an Audit Record — and
 * never how the Reach is put together.
 *
 * Nothing here reaches Drive. The Reach is real and both halves of its proof
 * run; the Minter behind it is a fake, so what these tests establish is roma's
 * half. What Google actually does with the request the real Minter makes is
 * written from documentation in `src/documents/google-document-minter.test.ts`
 * and, as ADR-0022's Verification status says first, has never been measured.
 */
describe('proving the Document Reach before anything can ask to use it', () => {
  // Both halves, in order, and the mint is thrown away — ADR-0015 §8's proof with
  // ADR-0022 §6's second half after it: a token can be had, and the folder that
  // token is for exists and takes children.
  it('mints one Document Token, throws it away, and reaches the Depot', async () => {
    const documentMinter = new FakeDocumentMinter()
    const roma = boot({ documentMinter })
    await roma.answerProbe()
    await roma.starting

    expect(documentMinter.minted).toHaveLength(1)
    expect(documentMinter.depots).toBe(1)
  })

  // A key that exists and does not work stops the boot, exactly as the cloud's
  // does. Wrapping the factory in a `try`/`catch` would turn this into a
  // deployment reporting it has no Document Reach, which is a lie told to every
  // Session (ADR-0020 §2).
  it('refuses to start at all when the key it was given does not work', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({ failsWith: new Error('the key was revoked') }),
    })

    await expect(roma.starting).rejects.toThrow(ConfigurationMissing)
    await expect(roma.starting).rejects.toThrow('the key was revoked')
    // Not one process. The paid check never ran, because a free one had already
    // answered.
    expect(roma.claude.spawns).toHaveLength(0)
  })

  // The half that is new to roma. Every other proof it makes says a credential is
  // *live*; this one says a permission is there, and a Depot nobody can write into
  // is a deployment whose first Task fails for a reason nothing at boot mentioned.
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

  // The Minter's own sentence, unwrapped. Which of the three things is wrong is
  // the whole value of that half of the proof (ADR-0022 §6), and a refusal that
  // paraphrased it would flatten a typo'd id, a share dialog nobody finished and
  // a Viewer role back into one.
  it('carries which of the three things is wrong into the refusal', async () => {
    const roma = boot({
      documentMinter: new FakeDocumentMinter({
        depotFailsWith: new Error('roma could not find the Depot: it is "TYPD_ID"'),
      }),
    })

    await expect(roma.starting).rejects.toThrow(/TYPD_ID/)
  })

  // Story 17 for the second optional Reach: a deployment that wants none pays
  // nothing for the feature. The both-or-neither half of that — one variable set
  // and not the other — is refused by `readDocumentEnv` before a Reach exists at
  // all, and is asserted there.
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

  // Story 19. Written on the boots with nothing to say as well, so that which
  // deployment an operator is looking at can be read off the log rather than
  // inferred from a line that is not there — which would mean two things at once.
  it('says so at boot when there is no Document Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'reach', credential: 'documents', account: null })
  })

  // Story 32, and the same distinction the other two Reaches keep: the credential
  // line beside this one is written per *request*, and the Shortcut asks on every
  // invocation by design.
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
  // **The pairing is the thing worth asserting.** A record over a closed union is
  // total by construction, so a Reach wired into the wrong slot typechecks — and
  // looks like everything working until the first API call, where a Drive request
  // arrives with a `cloud-platform` token on it (ADR-0020 §3). Asserted from the
  // only place that can see it: roma booted from its real parts, both Reaches
  // present, both asked over the same socket.
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

    // By prefix rather than by number, because two of the three boot proofs mint
    // and throw the token away — so the first token *served* is the second token
    // minted, and pinning the count here would be asserting the proof rather than
    // the pairing.
    expect(code.token, why).toMatch(/^token-/)
    expect(code.account, why).toBe('a-team')
    expect(cloud.token, why).toMatch(/^cloud-token-/)
    expect(cloud.account, why).toBe('agent@a-project.iam.gserviceaccount.com')
    expect(documents.token, why).toMatch(/^document-token-/)
    expect(documents.account, why).toBe('writer@a-project.iam.gserviceaccount.com')
  })

  // Story 18 through the socket rather than through the program: the Shortcut is
  // installed on every image, so what a deployment with no Document Reach answers
  // has to be a sentence an agent can repeat rather than a hang or a crash.
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
  // Story 33. Told nothing, the agent explains it has no way to write a document
  // when it has one — and discovery has to be free, because a Session remembers
  // nothing and a `--help` is a Turn.
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

  // A paragraph about a capability that is not there is worse than silence, and
  // an empty announcement is filtered before the join rather than joined and
  // trimmed — `--append-system-prompt` is gated on `undefined` and never on `''`.
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

/**
 * ADR-0022 §9: everything in a Depot is done as one service account, so Drive's
 * own record of what happened there names the account and never the person. The
 * Audit Record is the only place a Caller exists at all, which makes this the
 * only half of "who put this here" there is.
 */
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

  // The two booleans are kept apart, and this is what says so: a Task that
  // reached the cloud and never Drive must not be recorded as having written into
  // a folder a team shares. One observer over the socket, two memories behind it
  // (ADR-0020 §6).
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

  // Story 30's shape: a yes and a no, not a yes and a blank. A Task that never
  // touched the Depot has to say so, or the field cannot be read as an answer.
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
    const socket = socketPathIn(roma.shims.dir)
    const ask = () =>
      askMinter(socket, { session: sessionIdFor(KEY), operation: 'get', credential: 'cloud' })

    await ask()
    await ask()
    await ask()

    // Filtered on the credential as well as the event. The record is generic now,
    // so a filter on the event alone would span both Reaches and quietly stop
    // asserting what this test is named for.
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

  // New with ADR-0020 §5, and named there as something uniformity produced rather
  // than something anybody asked for. `git` asks on every invocation, so the mint
  // storm this record exists to make visible is likelier here than on the side it
  // was written for — and until now the forge's mints were invisible.
  it('records a mint for the forge as well, which it never used to', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting
    const socket = socketPathIn(roma.shims.dir)

    await askMinter(socket, { session: sessionIdFor(KEY), operation: 'get' })
    await askMinter(socket, { session: sessionIdFor(KEY), operation: 'get' })

    // One mint, two asks: the second was served from the token roma already held,
    // which is the distinction the record is for.
    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted' && r.credential === 'code'),
    ).toEqual([{ event: 'reach-token-minted', credential: 'code', account: 'a-team' }])
  })

  // The boot proof mints too, and is deliberately not one of these: it was never
  // served to anybody, and counting it would put a standing +1 on every
  // deployment's mint rate. The `cloud-reach` line is its record.
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
  // Discovery has to be free or the Shortcut defeats itself: a `--help` is a
  // Turn, a Session remembers nothing, and that is a Turn paid once per Session
  // to save Turns.
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

  // A paragraph about a capability that is not there is worse than silence: the
  // agent would attempt the work and report a command that does not exist.
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

/** Every regular file under these directories, read whole. Sockets are skipped. */
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

  // The socket reports every credential it serves now, and which one is worth
  // remembering is decided one layer up (ADR-0020 §6). Without that filter a `git`
  // asking for its own credential would mark the Task as having used the Cloud
  // Reach — a false yes on the one record that answers who spent somebody's Google
  // Cloud bill.
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

  // A yes and a no, not a yes and a blank. A Task that never touched the cloud
  // has to say so, or the field cannot be read as an answer at all.
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

  // Not under the work root, which is walked by a reclaim that deletes what has
  // gone a week untouched — a reclaimed socket would present as every credential
  // request in roma failing at once, with no explanation. Not inside a Working
  // Directory either: the agent runs `git add -A` in one of those.
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

  // The one thing that must never be in a process environment. It expires within
  // the hour, and a Resident Session outliving an hour is ordinary — and `env` in
  // a Turn would write it into a Transcript roma has promised never to delete.
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

/**
 * ADR-0030: one variable, and every Session roma serves is asked to be shorter.
 *
 * Asserted off the spawned process's own arguments rather than off anything roma
 * holds, because the claim is that the ruleset *reaches* a Session — everything
 * between the variable and the argv is what could go wrong.
 */
describe('telling a Session how short to be', () => {
  /** What one Session was appended, on a roma pinned to this Caveman. */
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

  // Every level an operator may pin, the two that will never be on the Menu
  // included. One boot each, because "an operator sets one variable" is the whole
  // feature and a level that could not be set would be a level roma does not have.
  it.each([...CAVEMAN_MENU, ...OFF_MENU_WENYAN].filter((level) => level !== CAVEMAN_OFF))(
    'carries the ruleset for %s into the spawn arguments',
    async (level) => {
      expect(await appendUnder(level)).toContain(cavemanRuleset(level))
    },
  )

  // After, on the blank-line rule the announcements already join by: the Caveman
  // is about how to answer and a Reach is about what roma can reach.
  it('puts it after whatever the Reaches had to say', async () => {
    expect(await appendUnder('ultra')).toBe(`reaches a-team/roma\n\n${cavemanRuleset('ultra')}`)
  })

  // Not the ruleset filtered to a level called off, which is thousands of
  // characters of instructions. caveman's own hook exits before filtering.
  it('says nothing at all where the Caveman is off', async () => {
    expect(await appendUnder(CAVEMAN_OFF)).toBe('reaches a-team/roma')
  })

  // **The deployment this ADR is not allowed to change.** The same string the
  // suite asserted before any of this existed, and it is asserted here as an
  // equality rather than a `toContain` so that a stray blank line or a default
  // that quietly became `full` cannot pass.
  it('leaves a deployment that named no Caveman byte-identical to before', async () => {
    expect(await appendUnder()).toBe('reaches a-team/roma')
  })

  /** What one Session's Task was written down as, on a roma pinned to this Caveman. */
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

  // **The half of ADR-0030 that only the composition root can get right.** An
  // unset `ROMA_CAVEMAN` becomes the Pinned Caveman `off` on its way into the
  // Chosen Record, so from there on a deployment that named nothing and one that
  // pinned `off` are one string — and a month of records that spelled both `off`
  // would answer the ADR's first verification question with a setting nobody
  // made. This is the only place the difference can be lost, which is why it is
  // asserted here rather than only where the Core resolves it.
  it('writes down that nothing named a Caveman, and tells that from pinning off', async () => {
    expect(await recordUnder()).toMatchObject({ caveman: CAVEMAN_NOT_PINNED })
    expect(await recordUnder(CAVEMAN_OFF)).toMatchObject({ caveman: CAVEMAN_OFF })
    expect(await recordUnder('ultra')).toMatchObject({ caveman: 'ultra' })
  })

  // The figure beside it, from a real boot: already computed for ADR-0018's
  // drift check and now written down, which is what makes the ADR's question
  // answerable from a deployment's own traffic. The record and never the month —
  // `/usage` is unchanged, and whoever compares two months is the reader.
  it('writes down what the Turn produced, as the Turn’s own delta', async () => {
    expect(await recordUnder('ultra')).toMatchObject({ outputTokens: 17 })
  })
})

/**
 * A roma serving more than one Channel, with every Core it builds counted.
 *
 * Its own helper rather than an option on `boot`, which hands back the one
 * Channel's Core and every test above leans on that.
 */
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

/** One message, as a Channel hands it to its Core. */
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

    // The probe and the first Channel's Task. The second waits for the slot.
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
      // @ts-expect-error -- fence:startup-durable-paths-are-required: auditRoot must stay required.
      const a: StartRomaOptions = noAuditRoot
      // @ts-expect-error -- fence:startup-durable-paths-are-required: configDir must stay required.
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
    // @ts-expect-error -- fence:startup-every-reach-is-named: a Reaches with no code Reach must not compile.
    const reaches: Reaches = noCode

    expect(Object.keys(reaches).sort(), why).toEqual(['cloud', 'documents'])
  })
})
