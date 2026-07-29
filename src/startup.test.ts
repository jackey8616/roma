import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Credential } from './build-env.js'
import { sessionIdFor } from './session-id.js'
import { startRoma, type Roma } from './startup.js'
import { StartupSelfCheckFailed } from './startup-self-check.js'
import type { ClaudeEvent } from './stream-events.js'
import { FakeClaude, flush } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { feed, recordedStream, upToFirst } from '../test/support/recorded-stream.js'

/** One complete Turn of a real recorded stream. Its text is "ok". */
const HEALTHY = recordedStream('three-turns-one-process').turn(1)
const STRAY_KEY = upToFirst(recordedStream('auth-failure').turn(1), 'system/init')

const OAUTH: Credential = { kind: 'shared-window', oauthToken: 'token' }
const KEY = 'conversation-one'

let started: Roma[] = []
let workRoots: string[] = []

function boot() {
  const claude = new FakeClaude({ exitOnKill: true })
  const workRoot = mkdtempSync(join(tmpdir(), 'roma-startup-'))
  const auditRoot = mkdtempSync(join(tmpdir(), 'roma-startup-audit-'))
  workRoots.push(workRoot, auditRoot)
  const channel = new RecordingAdapter()

  let resolved = false
  const starting = startRoma({
    credential: OAUTH,
    channel,
    workRoot,
    auditRoot,
    spawn: claude.spawn,
    log: () => {},
    selfCheckTimeoutMs: 1_000,
  }).then((roma) => {
    resolved = true
    started.push(roma)
    return roma
  })

  return {
    claude,
    channel,
    workRoot,
    auditRoot,
    starting,
    hasStarted: () => resolved,
    /** Answer the probe Turn, the way a real process would. */
    answerProbe: async (events: readonly ClaudeEvent[] = HEALTHY) => {
      await flush()
      feed(claude.process, events)
    },
  }
}

afterEach(async () => {
  for (const roma of started) await roma.shutdown()
  started = []
  for (const workRoot of workRoots) rmSync(workRoot, { recursive: true, force: true })
  workRoots = []
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

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', text: 'hello' })
    await flush()
    feed(roma.claude.processFor(join(roma.workRoot, sessionIdFor(KEY))), HEALTHY)
    await handled

    expect(roma.channel.instructions).toContainEqual(
      expect.objectContaining({ kind: 'result', text: 'ok' }),
    )
  })

  // The other half of that wiring, and the half nothing else would notice was
  // missing: a roma whose audit log was not connected answers every message
  // perfectly and records nobody's spending, which cannot be reconstructed
  // afterwards because the provider never knew who anyone was.
  it('writes the Task down, on the credential it was started with', async () => {
    const roma = boot()
    await roma.answerProbe()
    const { core, audit } = await roma.starting

    const handled = core.handle({ conversationKey: KEY, caller: 'someone', text: 'hello' })
    await flush()
    feed(roma.claude.processFor(join(roma.workRoot, sessionIdFor(KEY))), HEALTHY)
    await handled

    const month = new Date().toISOString().slice(0, 7)
    expect(audit.readMonth(month)).toMatchObject([
      {
        caller: 'someone',
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

    expect(audit.readMonth(new Date().toISOString().slice(0, 7))).toEqual([])
  })
})
