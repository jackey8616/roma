import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Core } from './core.js'
import type {
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from './channel-adapter.js'
import type { RetryBudget } from './config.js'
import { sessionIdFor } from './session-id.js'
import { SessionPool } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { TaskQueue } from './task-queue.js'
import { FakeClaude, flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { apiRetries, feed, recordedStream, upToFirst } from '../test/support/recorded-stream.js'

const stream = recordedStream('three-turns-one-process')
/** One complete Turn of a real recorded stream. Its text is "ok". */
const OK = stream.turn(1)
const FAILED = recordedStream('auth-failure').turn(1)
/** The real `api_retry` events a bad credential produced, 401 and all. */
const RETRIES = apiRetries('auth-failure')
/** 72 seconds of generation with `--include-partial-messages` on: 194 `text_delta` events. */
const GENERATING = recordedStream('generation-partial-messages').turn(1)
/**
 * A tool-using Turn up to the moment the tool starts.
 *
 * Where 25339ms of complete silence began in the capture, which is what a Task
 * that "produces no events for an extended period" actually looks like now that
 * generation itself is not silent.
 */
const TOOL_STARTS = upToFirst(
  recordedStream('tool-use-partial-messages').turn(1),
  'system/task_started',
)

/** ADR-0003's throttle interval, as `ProgressReporter` sizes it. */
const THROTTLE = 5_000

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

let pools: SessionPool[] = []
let workRoots: string[] = []

function newCore({
  workRoot = mkdtempSync(join(tmpdir(), 'roma-core-')),
  capabilities,
  ...options
}: {
  workRoot?: string
  retryBudget?: RetryBudget
  capabilities?: Partial<ChannelCapabilities>
} = {}) {
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

  // The real cap, so what the tests below see is what roma does.
  const queue = new TaskQueue()
  const adapter = new RecordingAdapter(capabilities)
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

/**
 * Instructions with their Task ids taken off.
 *
 * Most of what follows is about what a Conversation sees rather than about
 * correlating messages, and a uuid nothing asserts on only makes it harder to
 * read. Where the ids themselves matter they are asserted on directly.
 */
function posted(instructions: readonly OutboundInstruction[]) {
  return instructions.map(({ taskId, ...rest }) => rest)
}

/** Every progress instruction the Channel was given, in order. */
function progressOf(adapter: RecordingAdapter) {
  return adapter.instructions.filter((instruction) => instruction.kind === 'progress')
}

/** The ones that told a caller it was waiting. */
function queuedIn(adapter: RecordingAdapter) {
  return progressOf(adapter).filter((instruction) => instruction.progress.phase === 'queued')
}

beforeEach(() => {
  // setImmediate stays real so `flush` can still drain the microtask queue while
  // the progress throttle, the reap and the reclaim timers are under the test's
  // control.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: 1_800_000_000_000,
  })
})

afterEach(async () => {
  for (const pool of pools) await pool.shutdown()
  pools = []
  vi.useRealTimers()
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
  // search for, quote, and reply to months later, so it is never the
  // acknowledgement edited one last time.
  it('acknowledges the Task, then posts the result as its own message', async () => {
    const { adapter, say } = newCore()

    await say('hello')

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'result', conversationKey: KEY, text: 'ok' },
    ])
  })

  it("posts each Conversation's result back to its own Conversation", async () => {
    const { adapter, say } = newCore()

    await say('hello')
    await say('hello', { key: OTHER_KEY })

    expect(
      adapter.instructions
        .filter((instruction) => instruction.kind === 'result')
        .map((instruction) => instruction.conversationKey),
    ).toEqual([KEY, OTHER_KEY])
  })

  // A Task that fails and says nothing leaves someone waiting on work that is
  // already dead. The recording is a real 401, which arrives as is_error: true
  // wearing subtype: "success".
  it('says so when a Turn fails, rather than going quiet', async () => {
    const { adapter, say } = newCore()

    await say('hello', { events: FAILED })

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
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

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
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

    expect(
      posted(adapter.instructions.filter((instruction) => instruction.kind === 'result')),
    ).toEqual([
      { kind: 'result', conversationKey: KEY, text: 'ok' },
      { kind: 'result', conversationKey: KEY, text: '47' },
    ])
  })

  it('tells the second caller it is waiting rather than leaving it silent', async () => {
    const { adapter, claude, core, workRoot } = newCore()

    const first = core.runTask(ingress('first'))
    const second = core.runTask(ingress('second'))
    await flush()

    // Two Tasks in one Conversation, each acknowledged on its own message —
    // which is why an acknowledgement is named by a Task id and not by the
    // Conversation it is in.
    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'queued', position: 1 } },
    ])
    expect(new Set(progressOf(adapter).map((instruction) => instruction.taskId)).size).toBe(2)

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

    expect(posted(queuedIn(adapter))).toEqual([
      { kind: 'progress', conversationKey: 'four', progress: { phase: 'queued', position: 1 } },
      { kind: 'progress', conversationKey: 'five', progress: { phase: 'queued', position: 2 } },
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

    expect(queuedIn(adapter)).toEqual([])
  })

  // Progress is the one instruction roma will go without. A Channel too broken
  // to carry it is too broken to carry the failure that abandoning the Task
  // would produce, so dropping the work buys no less silence — it only adds
  // losing the work to it.
  it('still runs a Task whose caller could not be told anything about it', async () => {
    const { claude, pool, queue, workRoot, core: first } = newCore()
    const delivered: OutboundInstruction[] = []
    const core = new Core({
      channel: {
        capabilities: { messageMutation: true, stableConversationKey: true },
        toIngress: (event: IngressMessage) => event,
        deliver: (instruction) => {
          if (instruction.kind === 'progress') throw new Error('the Channel is down')
          delivered.push(instruction)
        },
      },
      pool,
      queue,
    })

    const running = first.runTask(ingress('first'))
    await flush()
    const behind = core.runTask(ingress('second'))

    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    feed(proc, OK)
    await running
    await flush()
    feed(proc, stream.turn(3))
    await behind

    expect(posted(delivered)).toEqual([{ kind: 'result', conversationKey: KEY, text: '47' }])
  })

  // The result is not the courtesy: an instruction that never reached the
  // Channel looks, from the Conversation, exactly like a message that was never
  // received, so whoever handed it in still has to hear about it.
  it('does not extend that to the result of a Task that waited', async () => {
    const { claude, pool, queue, workRoot, core: first } = newCore()
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

    const running = first.runTask(ingress('first'))
    await flush()
    const behind = core.runTask(ingress('second'))
    behind.catch(() => {})

    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    feed(proc, OK)
    await running
    await flush()
    feed(proc, stream.turn(3))

    await expect(behind).rejects.toThrow('the Channel is down')
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

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      {
        kind: 'failure',
        conversationKey: KEY,
        reason: 'roma gave up after 3 API retries (401 authentication_failed).',
      },
    ])
  })

  // The state ADR-0003 lists under accepted risks, reached with no Task hanging
  // at all: three misconfigured credentials and roma answers nobody. The fourth
  // message is sent while all three slots are still wedged, because "roma
  // recovers once they finish" is not what the risk is about.
  it('takes new work while three Tasks are all stuck on a bad credential', async () => {
    const { adapter, claude, core, workRoot } = newCore({ retryBudget })

    const stormed = ['one', 'two', 'three'].map((key) => core.runTask(ingress('hello', key)))
    await flush()
    const fourth = core.runTask(ingress('is anyone there?', 'four'))
    await flush()

    // Nothing is free, so it waits — but it is told so, and it is not refused.
    expect(claude.processes).toHaveLength(3)
    expect(posted(queuedIn(adapter))).toEqual([
      { kind: 'progress', conversationKey: 'four', progress: { phase: 'queued', position: 1 } },
    ])

    for (const proc of claude.processes) feed(proc, RETRIES.slice(0, 3))
    await Promise.all(stormed)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor('four'))), OK)
    await fourth

    expect(posted(adapter.instructions).at(-1)).toEqual({
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

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })
})

describe('telling a Conversation its Task is alive', () => {
  it('acknowledges the Task before it has produced anything at all', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
    ])

    feed(proc, OK)
    await task
  })

  // One message, edited. Every update carries the Task id the acknowledgement
  // carried, which is what tells an Adapter it is editing rather than posting —
  // and the result carries it too, so the Adapter knows which acknowledgement
  // is finished with.
  it('keeps every update on the acknowledgement rather than posting again', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    feed(proc, GENERATING.slice(-1))
    await task

    const updates = progressOf(adapter)
    expect(updates.map((instruction) => instruction.progress.phase)).toEqual(['working', 'writing'])
    expect(new Set(updates.map((instruction) => instruction.taskId)).size).toBe(1)
    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'result',
      taskId: updates[0]?.taskId,
    })
  })

  // 194 `text_delta` events in one Turn. A renderer that edited a message per
  // event would make 194 Channel calls, and nobody can read that fast anyway.
  it('does not turn a burst of stream events into a burst of updates', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await flush()

    expect(progressOf(adapter)).toHaveLength(1)

    feed(proc, GENERATING.slice(-1))
    await task
  })

  // The stream marks a tool starting and then says nothing until it finishes.
  // Naming what is running is the only thing that keeps the acknowledgement from
  // going stale for as long as the tool takes.
  it('names the tool that is running, so a tool window does not go stale', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, TOOL_STARTS)
    await vi.advanceTimersByTimeAsync(THROTTLE)

    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'progress',
      progress: { phase: 'tool', tool: expect.stringContaining('awk') },
    })

    feed(proc, OK)
    await task
  })

  // Suppression is the degrade ADR-0003 left open and now records. The result
  // is a separate message either way — that is the rule nothing makes
  // conditional.
  it('degrades to the acknowledgement alone where the Channel cannot edit', async () => {
    const { adapter, start } = newCore({ capabilities: { messageMutation: false } })

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await vi.advanceTimersByTimeAsync(20 * THROTTLE)
    feed(proc, GENERATING.slice(-1))
    await task

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'result', conversationKey: KEY, text: expect.any(String) },
    ])
  })

  // Progress is the one instruction roma will go without, so it must not become
  // the one that can silence a Task: a Channel that never finishes taking an
  // update still gets the result. Waiting on it before posting would make the
  // unconditional message hostage to the best-effort one.
  it('posts the result even where the Channel never finishes taking an update', async () => {
    const { claude, pool, queue, workRoot } = newCore()
    const delivered: OutboundInstruction[] = []
    const core = new Core({
      channel: {
        capabilities: { messageMutation: true, stableConversationKey: true },
        toIngress: (event: IngressMessage) => event,
        deliver: (instruction) => {
          if (instruction.kind === 'progress') return new Promise<void>(() => {})
          delivered.push(instruction)
        },
      },
      pool,
      queue,
    })

    const task = core.runTask(ingress('hello'))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(posted(delivered)).toEqual([{ kind: 'result', conversationKey: KEY, text: 'ok' }])
  })

  // Generation is no longer silent, so an extended silence now means a tool is
  // running — and tool runtime is unbounded, which is exactly why no threshold
  // separates a stalled tool call from a slow one. The rule that a Task ends
  // when it finishes or when a human stops it is unchanged; only the reason for
  // it moved, so do not reinstate a timeout on the old "generation is silent"
  // argument.
  it('runs no stall handling and no timeout on a Task that has gone quiet', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, TOOL_STARTS)
    await vi.advanceTimersByTimeAsync(30 * 60_000)

    expect(proc.signals).toEqual([])
    expect(proc.sent.filter((frame) => frame['type'] === 'control_request')).toEqual([])

    feed(proc, OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
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
