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

let started: Roma[] = []
let fixtures: RomaFixture[] = []

function boot({
  minter = new FakeMinter(),
  cloudMinter,
  documentMinter,
}: {
  minter?: FakeMinter
  /** Omitted, this roma has no Cloud Reach — which is the ordinary deployment. */
  cloudMinter?: FakeCloudMinter
  /** Omitted, this roma has no Document Reach — also the ordinary deployment. */
  documentMinter?: FakeDocumentMinter
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
    channel,
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
  }).then((roma) => {
    resolved = true
    started.push(roma)
    return roma
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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
  it('never touches another provider once the free check has refused', async () => {
    const cloudMinter = new FakeCloudMinter()
    const roma = boot({
      minter: new FakeMinter({ failsWith: new Error('a bad private key') }),
      cloudMinter,
    })

    await expect(roma.starting).rejects.toThrow('a bad private key')

    expect(cloudMinter.minted).toEqual([])
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
    const roma = boot({ cloudMinter: new FakeCloudMinter({ account: 'agent@a-project.iam.gserviceaccount.com' }) })
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
  it('says so at boot when there is no Cloud Reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(roma.log).toContainEqual({ event: 'reach', credential: 'cloud', account: null })
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
        depotFailsWith: new Error('roma can see the Depot "FOLDER_ID" and cannot add anything to it'),
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
      documentMinter: new FakeDocumentMinter({ account: 'writer@a-project.iam.gserviceaccount.com' }),
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
    const documentMinter = new FakeDocumentMinter({ account: 'writer@a-project.iam.gserviceaccount.com' })
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
  it('answers each request with its own Reach’s token and account', async () => {
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
    expect(code.token).toMatch(/^token-/)
    expect(code.account).toBe('a-team')
    expect(cloud.token).toMatch(/^cloud-token-/)
    expect(cloud.account).toBe('agent@a-project.iam.gserviceaccount.com')
    expect(documents.token).toMatch(/^document-token-/)
    expect(documents.account).toBe('writer@a-project.iam.gserviceaccount.com')
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
      documentMinter: new FakeDocumentMinter({ account: 'writer@a-project.iam.gserviceaccount.com' }),
    })
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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
  it('does not count the mint that proved the key at boot', async () => {
    const roma = boot({ cloudMinter: new FakeCloudMinter() })
    await roma.answerProbe()
    await roma.starting

    expect(
      roma.log.filter((r) => r.event === 'reach-token-minted' && r.credential === 'cloud'),
    ).toEqual([])
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
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
  it('keeps the socket and the gitconfig in a directory of roma’s own', async () => {
    const roma = boot()
    await roma.answerProbe()
    await roma.starting

    expect(existsSync(socketPathIn(roma.shims.dir))).toBe(true)
    expect(readFileSync(join(roma.shims.dir, 'gitconfig'), 'utf8')).toBe(
      roma.shims.gitConfig,
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello', enclosures: [], quotation: null })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.minter.minted).toEqual([])
    expect(Object.keys(env)).not.toContain('GH_TOKEN')
  })
})
