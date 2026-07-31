import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { monthOf } from './audit-log.js'
import type { Credential } from './build-env.js'
import { sessionIdFor } from './session-id.js'
import { socketPathIn } from './shim-protocol.js'
import { startRoma, type Roma } from './startup.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import { flush } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { fakeMinting, FakeMinter } from '../test/support/fake-minter.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../test/support/roma-fixture.js'
import { feed, OK, STRAY_KEY } from '../test/support/recorded-stream.js'

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'token' }
const KEY = 'conversation-one'

let started: Roma[] = []
let fixtures: RomaFixture[] = []

function boot({ minter = new FakeMinter() }: { minter?: FakeMinter } = {}) {
  const fixture = romaFixture('startup')
  fixtures.push(fixture)
  const minting = fakeMinting({ minter })
  fixture.alsoRemove(minting.shimDir)
  const channel = new RecordingAdapter()

  let resolved = false
  const starting = startRoma({
    credential: OAUTH,
    channel,
    ...fixture.dirs,
    minting,
    spawn: fixture.claude.spawn,
    log: () => {},
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
    minting,
    starting,
    hasStarted: () => resolved,
    answerProbe: fixture.answerProbe,
    procFor: fixture.procFor,
  }
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello' })
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
    })
    const handled = core.handle({
      conversationKey: KEY,
      caller: 'someone',
      callerName: 'Someone',
      text: 'hello',
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello' })
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

describe('putting a credential in front of a Session’s tools', () => {
  it('tells every Session what it can reach', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello' })
    await flush()
    const spawn = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    const at = spawn.args.indexOf('--append-system-prompt')
    expect(spawn.args[at + 1]).toBe('reaches a-team/roma')
  })

  it('tells every Session where to ask for a credential, and who is asking', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello' })
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', callerName: 'Someone', text: 'hello' })
    await flush()
    const { env } = roma.claude.lastSpawn
    feed(roma.procFor(KEY), OK)
    await handled

    expect(roma.minter.minted).toEqual([])
    expect(Object.keys(env)).not.toContain('GH_TOKEN')
  })
})
