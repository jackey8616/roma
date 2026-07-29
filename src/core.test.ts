import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Core } from './core.js'
import type { IngressMessage, OutboundInstruction } from './channel-adapter.js'
import type { RetryBudget } from './config.js'
import { sessionIdFor } from './session-id.js'
import { SessionPool } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { TaskQueue } from './task-queue.js'
import { FakeClaude, flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { feed, recordedStream } from '../test/support/recorded-stream.js'

const stream = recordedStream('three-turns-one-process')
/** One complete Turn of a real recorded stream. Its text is "ok". */
const OK = stream.turn(1)
const FAILED = recordedStream('auth-failure').turn(1)
/** The real `api_retry` events a bad credential produced, 401 and all. */
const RETRIES = recordedStream('auth-failure').events.filter(
  (event) => event.type === 'system' && event['subtype'] === 'api_retry',
)

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

let pools: SessionPool[] = []
let workRoots: string[] = []

function newCore({
  workRoot = mkdtempSync(join(tmpdir(), 'roma-core-')),
  ...options
}: { workRoot?: string; maxConcurrent?: number; retryBudget?: RetryBudget } = {}) {
  const claude = new FakeClaude({ exitOnKill: true })
  workRoots.push(workRoot)
  const pool = new SessionPool({
    workRoot,
    env: { PATH: '/usr/bin' },
    spawn: claude.spawn,
    log: () => {},
    ...(options.retryBudget === undefined ? {} : { retryBudget: options.retryBudget }),
  })
  pools.push(pool)

  const queue = new TaskQueue({
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  })
  const adapter = new RecordingAdapter()
  const core = new Core({ channel: adapter, pool, queue })

  /** Deliver one message to the Core and serve the Turn it drives from a recording. */
  const say = async (
    text: string,
    { key = KEY, events = OK }: { key?: string; events?: readonly ClaudeEvent[] } = {},
  ): Promise<void> => {
    const task = core.runTask(ingress(text, key))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(key))), events)
    await task
  }

  /** Start a Task without waiting for it, and hand back the process serving it. */
  const start = async (
    text: string,
    key = KEY,
  ): Promise<{ task: Promise<void>; proc: FakeClaudeProcess }> => {
    const task = core.runTask(ingress(text, key))
    task.catch(() => {})
    await flush()
    return { task, proc: claude.processFor(join(workRoot, sessionIdFor(key))) }
  }

  return { adapter, claude, core, pool, queue, workRoot, say, start }
}

function ingress(text: string, conversationKey = KEY): IngressMessage {
  return { conversationKey, caller: 'someone', text }
}

afterEach(async () => {
  for (const pool of pools) await pool.shutdown()
  pools = []
  for (const root of workRoots) rmSync(root, { recursive: true, force: true })
  workRoots = []
})

describe('finding the Session a message belongs to', () => {
  it('reaches the Session its Conversation Key derives, with nothing looked up', async () => {
    const { claude, say } = newCore()

    await say('hello')

    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY))
  })

  it('serves a follow-up in the same Conversation from the same Session', async () => {
    const { claude, say } = newCore()

    await say('first')
    await say('second', { events: stream.turn(3) })

    expect(claude.processes).toHaveLength(1)
  })

  it('gives two Conversations two Sessions', async () => {
    const { claude, say } = newCore()

    await say('hello')
    await say('hello', { key: OTHER_KEY })

    expect(claude.processes).toHaveLength(2)
    expect(claude.spawns.map((spawn) => spawn.cwd)).toEqual([
      expect.stringContaining(sessionIdFor(KEY)),
      expect.stringContaining(sessionIdFor(OTHER_KEY)),
    ])
  })

  // No database, and therefore nothing to restore: a roma that has just started,
  // on a machine that has never seen this Conversation, computes the same id.
  it('reaches the same Session from a roma that remembers nothing', async () => {
    const first = newCore()
    await first.say('hello')
    const second = newCore()

    await second.say('hello')

    expect(second.claude.lastSpawn.args).toEqual(first.claude.lastSpawn.args)
  })
})

describe('what the Channel is asked to post', () => {
  // The final result is its own message, unconditionally. It is what people
  // search for, quote, and reply to months later.
  it('posts the result of the Turn and nothing else', async () => {
    const { adapter, say } = newCore()

    await say('hello')

    expect(adapter.instructions).toEqual([{ kind: 'result', conversationKey: KEY, text: 'ok' }])
  })

  it("posts each Conversation's result back to its own Conversation", async () => {
    const { adapter, say } = newCore()

    await say('hello')
    await say('hello', { key: OTHER_KEY })

    expect(adapter.instructions.map((instruction) => instruction.conversationKey)).toEqual([
      KEY,
      OTHER_KEY,
    ])
  })

  // A Task that fails and says nothing leaves someone waiting on work that is
  // already dead. The recording is a real 401, which arrives as is_error: true
  // wearing subtype: "success".
  it('says so when a Turn fails, rather than going quiet', async () => {
    const { adapter, say } = newCore()

    await say('hello', { events: FAILED })

    expect(adapter.instructions).toEqual([
      { kind: 'failure', conversationKey: KEY, reason: expect.stringContaining('401') },
    ])
  })

  // Not "claude exited mid-Turn (code=1, signal=null)", and not a Session uuid.
  // Those are written for whoever is reading the code; a person in a
  // Conversation cannot act on either, and neither is theirs to see. What they
  // need is to know the Task is dead so they stop waiting for it.
  it("says so when the Session could not run at all, in roma's own words", async () => {
    const { adapter, claude, core } = newCore()

    const task = core.runTask(ingress('hello'))
    await flush()
    claude.process.emitExit({ code: 1, signal: null })
    await task

    expect(adapter.instructions).toEqual([
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not run this Task.' },
    ])
  })

  // Reporting the failure is the Core's answer to it — a Conversation that has
  // been told cannot be told again by whoever called us.
  it('does not also throw a failure it has already reported', async () => {
    const { say } = newCore()

    await expect(say('hello', { events: FAILED })).resolves.toBeUndefined()
  })

  // The one thing the Core cannot absorb. An instruction that never reached the
  // Channel looks, from the Conversation, exactly like a message that was never
  // received — so whoever handed it in has to hear about it.
  it('does not swallow an instruction the Channel never carried out', async () => {
    const { pool, queue, claude, workRoot } = newCore()
    // A second Core over the same pool and queue: one Core per Channel is what
    // keeps the Core free of Channel identity, and both are shared between them.
    const core = new Core({
      channel: {
        capabilities: { messageMutation: true, stableConversationKey: true },
        toIngress: (event: IngressMessage) => event,
        deliver: () => {
          throw new Error('the Channel is down')
        },
      },
      pool,
      queue,
    })

    const task = core.runTask(ingress('hello'))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)

    await expect(task).rejects.toThrow('the Channel is down')
  })
})

describe('handling one Conversation one Task at a time', () => {
  // Forced, not chosen: two processes writing one Session file corrupt it. Two
  // messages sent in quick succession therefore queue rather than race.
  it('does not send a second message while the first Task is still running', async () => {
    const { claude, core, workRoot } = newCore()

    const first = core.runTask(ingress('first'))
    const second = core.runTask(ingress('second'))
    await flush()
    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))

    expect(claude.processes).toHaveLength(1)
    expect(proc.sent).toHaveLength(1)

    feed(proc, OK)
    await first
    await flush()
    feed(proc, stream.turn(3))
    await second

    expect(proc.sent).toHaveLength(2)
  })

  it('answers both, in the order they arrived', async () => {
    const { adapter, claude, core, workRoot } = newCore()

    const first = core.runTask(ingress('first'))
    const second = core.runTask(ingress('second'))
    await flush()
    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    feed(proc, OK)
    await first
    await flush()
    feed(proc, stream.turn(3))
    await second

    expect(adapter.instructions.filter((instruction) => instruction.kind === 'result')).toEqual([
      { kind: 'result', conversationKey: KEY, text: 'ok' },
      { kind: 'result', conversationKey: KEY, text: '47' },
    ])
  })

  it('tells the second caller it is waiting rather than leaving it silent', async () => {
    const { adapter, claude, core, workRoot } = newCore()

    const first = core.runTask(ingress('first'))
    const second = core.runTask(ingress('second'))
    await flush()

    expect(adapter.instructions).toEqual([{ kind: 'queued', conversationKey: KEY, position: 1 }])

    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    feed(proc, OK)
    await first
    await flush()
    feed(proc, stream.turn(3))
    await second
  })
})

describe('running only so much at once', () => {
  it('runs at most three Tasks across every Conversation', async () => {
    const { claude, core } = newCore()

    const tasks = ['one', 'two', 'three', 'four'].map((key) => core.runTask(ingress('hello', key)))
    await flush()

    expect(claude.processes).toHaveLength(3)

    for (const proc of claude.processes) feed(proc, OK)
    await Promise.all(tasks.slice(0, 3))
    await flush()
    feed(claude.process, OK)
    await tasks[3]
  })

  it('tells the fourth caller where it is in the queue', async () => {
    const { adapter, claude, core } = newCore()

    const tasks = ['one', 'two', 'three', 'four', 'five'].map((key) =>
      core.runTask(ingress('hello', key)),
    )
    await flush()

    expect(adapter.instructions).toEqual([
      { kind: 'queued', conversationKey: 'four', position: 1 },
      { kind: 'queued', conversationKey: 'five', position: 2 },
    ])

    for (const proc of claude.processes) feed(proc, OK)
    await Promise.all(tasks.slice(0, 3))
    await flush()
    for (const proc of claude.processes.slice(3)) feed(proc, OK)
    await Promise.all(tasks)
  })

  it('says nothing about queueing to a Task that starts straight away', async () => {
    const { adapter, say } = newCore()

    await say('hello')

    expect(adapter.instructions.map((instruction) => instruction.kind)).toEqual(['result'])
  })

  // Someone who believes their message was never received is exactly what the
  // notice exists to prevent, so a Task whose notice never landed is not one to
  // run in the background either.
  it('does not run a Task whose caller could not be told it was waiting', async () => {
    const { claude, pool, queue, workRoot, core: first } = newCore()
    const delivered: OutboundInstruction[] = []
    const core = new Core({
      channel: {
        capabilities: { messageMutation: true, stableConversationKey: true },
        toIngress: (event: IngressMessage) => event,
        deliver: (instruction) => {
          if (instruction.kind === 'queued') throw new Error('the Channel is down')
          delivered.push(instruction)
        },
      },
      pool,
      queue,
    })

    const running = first.runTask(ingress('first'))
    await flush()
    await core.runTask(ingress('second'))

    // Told it is over, which is true, rather than left to run unannounced.
    expect(delivered).toEqual([
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not run this Task.' },
    ])

    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await running
    await flush()

    expect(claude.processFor(join(workRoot, sessionIdFor(KEY))).sent).toHaveLength(1)
  })
})

describe('giving up on a Task that is only retrying', () => {
  const retryBudget = { maxApiRetries: 3, windowMs: 60_000 }

  // A bad credential does not fail fast: ten retries across 182 seconds before
  // the 401 surfaced. Waiting for it holds a slot for over three minutes.
  it('surfaces what the retries were failing on, rather than waiting them out', async () => {
    const { adapter, start } = newCore({ retryBudget })

    const { task, proc } = await start('hello')
    feed(proc, RETRIES.slice(0, 3))
    await task

    expect(adapter.instructions).toEqual([
      {
        kind: 'failure',
        conversationKey: KEY,
        reason: 'roma gave up after 3 API retries (401 authentication_failed).',
      },
    ])
  })

  // The state ADR-0003 lists under accepted risks, reached with no Task hanging
  // at all: three misconfigured credentials and roma answers nobody.
  it('still takes new work after three Tasks have all hit a bad credential', async () => {
    const { adapter, claude, core, say } = newCore({ retryBudget })

    const stormed = ['one', 'two', 'three'].map((key) => core.runTask(ingress('hello', key)))
    await flush()
    for (const proc of claude.processes) feed(proc, RETRIES.slice(0, 3))
    await Promise.all(stormed)

    await say('is anyone there?', { key: 'four' })

    expect(adapter.instructions.at(-1)).toEqual({
      kind: 'result',
      conversationKey: 'four',
      text: 'ok',
    })
  })

  it('leaves a Task that retries within its budget alone', async () => {
    const { adapter, start } = newCore({ retryBudget })

    const { task, proc } = await start('hello')
    feed(proc, [...RETRIES.slice(0, 2), ...OK])
    await task

    expect(adapter.instructions).toEqual([{ kind: 'result', conversationKey: KEY, text: 'ok' }])
  })
})

describe('knowing nothing about which Channel a message came from', () => {
  it('refuses a Channel that cannot supply a stable Conversation Key', () => {
    const { pool, queue } = newCore()
    const adapter = new RecordingAdapter({ stableConversationKey: false })

    expect(() => new Core({ channel: adapter, pool, queue })).toThrow(/stable/i)
  })

  // "Google Chat is the first road, not the destination" is a claim the code has
  // to keep. Enforced here rather than by intent, because the day it stops being
  // true is the day a second Channel becomes a rewrite instead of an Adapter.
  it('never names a Channel anywhere in the Core', () => {
    const offenders = coreSources().filter(({ source }) =>
      CHANNEL_SPECIFIC.some((pattern) => pattern.test(source)),
    )

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

const CHANNEL_SPECIFIC = [
  /google\s*chat/i,
  /chat\.googleapis/i,
  /pub\s*\/?\s*sub/i,
  /\bslack\b/i,
  /\bdiscord\b/i,
  /messageReplyOption/,
  /spaceThreadingState/,
]

/**
 * Every Core source file: all of `src/`, minus the tests, minus `src/channels/`.
 *
 * `src/channels/<channel>/` is where a Channel Adapter goes, and it is the only
 * place in the tree allowed to know which product a message came from.
 */
function coreSources(): { file: string; source: string }[] {
  const src = fileURLToPath(new URL('.', import.meta.url))
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .filter((file) => !file.split(sep).includes('channels'))
    .map((file) => ({ file, source: readFileSync(join(src, file), 'utf8') }))
}
