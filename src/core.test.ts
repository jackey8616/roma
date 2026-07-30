import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, monthOf } from './audit-log.js'
import { Core, type CoreLogRecord } from './core.js'
import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from './channel-adapter.js'
import type { RetryBudget } from './config.js'
import { SessionGenerations } from './session-generation.js'
import { sessionIdFor } from './session-id.js'
import { SessionPool } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { TaskQueue } from './task-queue.js'
import { FakeClaude, flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import {
  apiRetries,
  feed,
  kindOf,
  recordedStream,
  upToFirst,
  quotaEvent,
  withApiKeySource,
  withTotalCostUsd,
} from '../test/support/recorded-stream.js'
import { sources, type Source } from '../test/support/sources.js'

const stream = recordedStream('three-turns-one-process')
/** One complete Turn of a real recorded stream. Its text is "ok". */
const OK = stream.turn(1)
const FAILED = recordedStream('auth-failure').turn(1)
/**
 * The same 401 with its retry storm taken out, so the Turn fails on its own.
 *
 * The capture holds ten `api_retry` events before the error surfaces, which is
 * more than the retry budget allows — fed whole, it is a Task roma abandons
 * rather than one Claude Code failed, and those are different endings with
 * different costs.
 */
const FAILED_OUTRIGHT = FAILED.filter((event) => kindOf(event) !== 'system/api_retry')
/**
 * A Turn that failed with the Shared Window reported spent.
 *
 * Built rather than captured: every recording roma holds says `status:
 * "allowed"`, and the only way to record the other case is to drain the window
 * everybody shares. `spentUntil` in `src/quota.ts` is where that guess lives.
 */
const BLOCKED = [quotaEvent({ status: 'blocked' }), ...FAILED_OUTRIGHT]
/** The same, with the provider willing to sell overage. */
const BLOCKED_WITH_OVERAGE = [
  quotaEvent({ status: 'blocked', overageStatus: 'allowed' }),
  ...FAILED_OUTRIGHT,
]
/** When the window comes back, as the capture's own event reports it. */
const RESETS_AT = 1785271200
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

/**
 * The clock these tests run on: an hour before the window the captures were
 * recorded against comes back.
 *
 * Tied to the recording rather than picked, because a clock that had already
 * passed `resetsAt` would make every park expire the instant it started, and the
 * tests would pass while proving nothing about waiting.
 */
const UNTIL_RESET = 60 * 60_000
const NOW = RESETS_AT * 1000 - UNTIL_RESET
/** Which month their Audit Records are filed in, which follows from the clock. */
const MONTH = monthOf(new Date(NOW))

let pools: SessionPool[] = []
let workRoots: string[] = []

function newCore({
  workRoot = mkdtempSync(join(tmpdir(), 'roma-core-')),
  auditDir = mkdtempSync(join(tmpdir(), 'roma-core-audit-')),
  overflow = { monthlyCapUsd: 100 },
  capabilities,
  ...options
}: {
  workRoot?: string
  auditDir?: string
  /** Null for a deployment with no metered credential at all. */
  overflow?: { monthlyCapUsd: number } | null
  retryBudget?: RetryBudget
  capabilities?: Partial<ChannelCapabilities>
} = {}) {
  const claude = new FakeClaude({ exitOnKill: true })
  workRoots.push(workRoot, auditDir)
  const pool = new SessionPool({
    workRoot,
    envs: {
      // A function of the Session, because two of the variables a real one
      // carries are the Session's own. Nothing here needs them, so the Session
      // id is written down and otherwise ignored.
      'shared-window': (sessionId) => ({
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
        ROMA_SESSION_ID: sessionId,
      }),
      overflow: (sessionId) => ({
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'metered-key',
        ROMA_SESSION_ID: sessionId,
      }),
    },
    spawn: claude.spawn,
    log: () => {},
    ...(options.retryBudget === undefined ? {} : { retryBudget: options.retryBudget }),
  })
  pools.push(pool)

  // The real cap, so what the tests below see is what roma does.
  const queue = new TaskQueue()
  const sessions = new SessionGenerations({ workRoot })
  const adapter = new RecordingAdapter(capabilities)
  const audit = new AuditLog({ auditRoot: auditDir })
  const log: CoreLogRecord[] = []
  const core = new Core({
    channel: adapter,
    pool,
    queue,
    sessions,
    audit,
    credential: 'shared-window',
    log: (record) => log.push(record),
    ...(overflow === null ? {} : { overflow }),
  })

  /**
   * Deliver one message to the Core and serve the Turn it drives from a
   * recording.
   *
   * `session` is which Session is expected to serve it, and defaults to the one
   * a Conversation that has never used `/new` is on.
   */
  const say = async (
    text: string,
    {
      key = KEY,
      events = OK,
      session = sessionIdFor(key),
    }: { key?: string; events?: readonly ClaudeEvent[]; session?: string } = {},
  ): Promise<void> => {
    const task = core.handle(ingress(text, key))
    await flush()
    feed(claude.processFor(join(workRoot, session)), events)
    await task
  }

  /** Start a Task without waiting for it, and hand back the process serving it. */
  const start = async (
    text: string,
    key = KEY,
  ): Promise<{ task: Promise<void>; proc: FakeClaudeProcess }> => {
    const task = core.handle(ingress(text, key))
    task.catch(() => {})
    await flush()
    return { task, proc: claude.processFor(join(workRoot, sessionIdFor(key))) }
  }

  return { adapter, audit, claude, core, log, pool, queue, sessions, workRoot, say, start }
}

/**
 * A Task left parked at the end of a test.
 *
 * A blocked Task waits for the window to come back, which most of these tests
 * never let happen — what they assert is what was said at the moment of
 * blocking. Its promise is already caught by `start`, and the park's timer goes
 * with the fake clock, so leaving it is deliberate rather than forgotten.
 */
function leftParked(task: Promise<void>): void {
  void task
}

/** The Task the Channel was last told about, by its id. */
function taskIdOf(adapter: RecordingAdapter): string {
  const instruction = adapter.instructions.at(-1)
  if (instruction === undefined) throw new Error('the Channel has been told nothing')
  return instruction.taskId
}

/** Every Audit Record these tests have produced, in the order the Tasks ended. */
function recordsIn(audit: AuditLog) {
  return audit.readMonth(MONTH)
}

/**
 * A second Core on another Core's Channel-less half.
 *
 * One Core per Channel, over one pool, one queue, one generation record and one
 * audit log — the Core's own contract says every one of those is roma-wide. So a
 * test that wants a Channel of its own wants this rather than a second roma, and
 * gathering it here is also what keeps the next option the Core gains from being
 * pasted into six places.
 */
function coreOver(shared: ReturnType<typeof newCore>, channel: ChannelAdapter): Core {
  return new Core({
    channel,
    pool: shared.pool,
    queue: shared.queue,
    sessions: shared.sessions,
    audit: shared.audit,
    credential: 'shared-window',
  })
}

/** A Channel that can do everything and does one thing with what it is given. */
function channelThat(deliver: ChannelAdapter['deliver']): ChannelAdapter<IngressMessage> {
  return {
    capabilities: { messageMutation: true, stableConversationKey: true },
    toIngress: (event: IngressMessage) => event,
    deliver,
  }
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
    now: NOW,
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

    const task = core.handle(ingress('hello'))
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
    const shared = newCore()
    const { claude, workRoot } = shared
    // A second Core over the same pool and queue: one Core per Channel is what
    // keeps the Core free of Channel identity, and both are shared between them.
    const core = coreOver(
      shared,
      channelThat(() => {
        throw new Error('the Channel is down')
      }),
    )

    const task = core.handle(ingress('hello'))
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

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
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

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
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

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
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

    const tasks = ['one', 'two', 'three', 'four'].map((key) => core.handle(ingress('hello', key)))
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
      core.handle(ingress('hello', key)),
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
    const shared = newCore()
    const { claude, workRoot, core: first } = shared
    const delivered: OutboundInstruction[] = []
    const core = coreOver(
      shared,
      channelThat((instruction) => {
        if (instruction.kind === 'progress') throw new Error('the Channel is down')
        delivered.push(instruction)
      }),
    )

    const running = first.handle(ingress('first'))
    await flush()
    const behind = core.handle(ingress('second'))

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
    const shared = newCore()
    const { claude, workRoot, core: first } = shared
    const core = coreOver(
      shared,
      channelThat(() => {
        throw new Error('the Channel is down')
      }),
    )

    const running = first.handle(ingress('first'))
    await flush()
    const behind = core.handle(ingress('second'))
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

    const stormed = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const fourth = core.handle(ingress('is anyone there?', 'four'))
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

  // The acknowledgement is finished with the moment the answer is posted, and an
  // Adapter is entitled to act on that: the one roma has drops the message it was
  // editing, so an update arriving afterwards has nothing to edit and posts a new
  // message — a stale "Working…" underneath the answer it is reporting on.
  //
  // Reachable only against a slow Channel, which is why the Adapter is held here:
  // an update roma queued behind one still in flight is handed over after the
  // Turn has ended, and the throttle is 5s against a Turn that can end 85ms after
  // its last token.
  it('sends no update after the answer, however slow the Channel is', async () => {
    const { adapter, start } = newCore()
    const release = adapter.hold('progress')

    const { task, proc } = await start('hello')
    // A second update, queued behind the acknowledgement the Channel is still
    // taking rather than sent.
    feed(proc, GENERATING.slice(0, -1))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    feed(proc, GENERATING.slice(-1))
    await task

    release()
    await flush()

    const kinds = adapter.instructions.map((instruction) => instruction.kind)
    expect(kinds.slice(kinds.indexOf('result'))).toEqual(['result'])
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
    const shared = newCore()
    const { claude, workRoot } = shared
    const delivered: OutboundInstruction[] = []
    const core = coreOver(
      shared,
      channelThat((instruction) => {
        if (instruction.kind === 'progress') return new Promise<void>(() => {})
        delivered.push(instruction)
      }),
    )

    const task = core.handle(ingress('hello'))
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

describe('the two Commands roma answers itself', () => {
  /** A real interrupt: the aborted Turn, then the Turn the same process served next. */
  const INTERRUPTED = recordedStream('interrupted-turn')

  // The whole point of the in-band interrupt over SIGTERM: the Session is not
  // spent stopping a Task, so the next message can redirect it immediately
  // rather than start over from a cold resume.
  it('ends the Task running now and leaves the Session able to take the next message', async () => {
    const { claude, core, start, say } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))

    expect(proc.sent.at(-1)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    expect(proc.signals).toEqual([])

    feed(proc, INTERRUPTED.turn(1))
    await task
    await say('are you still there', { events: INTERRUPTED.turn(2) })

    expect(claude.processes).toHaveLength(1)
    expect(claude.process.pid).toBe(proc.pid)
  })

  // Not a failure: roma did not break, and the reason a failure carries would be
  // the half-written answer the interrupt cut off. Not a silent completion
  // either — a Task that ends with nothing said leaves someone waiting for a
  // result that is never coming.
  it('reports a stopped Task as stopped', async () => {
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))
    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'command-outcome', conversationKey: KEY, command: 'stop', carriedOut: true },
      { kind: 'stopped', conversationKey: KEY },
    ])
    // The outcome belongs to the Task that was stopped, not to the Command that
    // stopped it: it is that Task's acknowledgement the Conversation is watching.
    const [acknowledgement, command, stopped] = adapter.instructions
    expect(stopped?.taskId).toBe(acknowledgement?.taskId)
    expect(command?.taskId).not.toBe(acknowledgement?.taskId)
  })

  // A Command that queued would be serialised against its own Conversation and
  // would therefore wait for the Task it was sent to stop, arriving once that
  // Task had finished — the one moment it is no use at all.
  it('does not wait behind the Task it is stopping', async () => {
    const { core, queue, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))

    expect(queue.running).toBe(1)
    expect(queue.waiting).toBe(0)

    feed(proc, INTERRUPTED.turn(1))
    await task
  })

  // Nor does it take a concurrency slot. With all three Tasks running, a Command
  // that counted as a fourth would be exactly the message that cannot get
  // through: the one asking roma to stop doing something.
  it('gets through while roma is running as much as it runs at once', async () => {
    const { adapter, claude, core, workRoot } = newCore()
    const tasks = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    for (const task of tasks) task.catch(() => {})
    await flush()

    await core.handle(ingress('/stop', 'one'))

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'command-outcome',
      conversationKey: 'one',
      command: 'stop',
      carriedOut: true,
    })

    feed(claude.processFor(join(workRoot, sessionIdFor('one'))), INTERRUPTED.turn(1))
    for (const key of ['two', 'three']) {
      feed(claude.processFor(join(workRoot, sessionIdFor(key))), OK)
    }
    await Promise.all(tasks)
  })

  // A Task and its Conversation can end up on different Sessions, and only one
  // of them is the Task: `/new` moves the Conversation on while the work it was
  // asked to stop carries on where it started. Asking which Session the
  // Conversation is on now would interrupt an empty one and report that nothing
  // was running, while the Task nobody wants keeps going.
  it('stops the Task it was sent to stop, even after a /new moved the Conversation', async () => {
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/new'))
    await core.handle(ingress('/stop'))

    expect(proc.sent.at(-1)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })

    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({ kind: 'stopped', conversationKey: KEY })
  })

  // Between arriving and its first token a Task can be queued behind three
  // others — minutes in which it is visibly running, `/stop` is exactly what a
  // person would send, and there is no Turn to interrupt. A Task stopped there
  // must not quietly run later.
  it('stops a Task that has not started yet, rather than letting it run later', async () => {
    const { adapter, claude, core, workRoot } = newCore()
    const busy = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const waiting = core.handle(ingress('a long job', 'four'))
    await flush()

    await core.handle(ingress('/stop', 'four'))

    for (const key of ['one', 'two', 'three']) {
      feed(claude.processFor(join(workRoot, sessionIdFor(key))), OK)
    }
    await Promise.all(busy)
    await waiting

    // Never spawned: the fourth Session has no process at all.
    expect(claude.processes).toHaveLength(3)
    expect(
      posted(adapter.instructions).filter(({ conversationKey }) => conversationKey === 'four'),
    ).toEqual([
      { kind: 'progress', conversationKey: 'four', progress: { phase: 'queued', position: 1 } },
      { kind: 'command-outcome', conversationKey: 'four', command: 'stop', carriedOut: true },
      { kind: 'stopped', conversationKey: 'four' },
    ])
  })

  // The same window at the other end: admitted, and waiting on a cold start.
  // There is nothing to interrupt yet, so the request is sent the moment the
  // Turn begins instead — the alternative is a Task that was stopped answering
  // as though it never had been.
  it('stops a Task whose process has not finished starting', async () => {
    const { adapter, claude, core, workRoot } = newCore()
    const task = core.handle(ingress('write me an essay'))
    task.catch(() => {})

    await core.handle(ingress('/stop'))
    await flush()

    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    expect(proc.sent.map((frame) => frame['type'])).toEqual(['user', 'control_request'])

    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({ kind: 'stopped', conversationKey: KEY })
  })

  // Everything this Conversation has in flight, not just the one at the front.
  // Stopping the running Task and then starting the one queued behind it would
  // be roma carrying on with work the person has just said to stop, and the
  // second message is the one they would have to watch for.
  it('stops both messages of a Conversation that sent two', async () => {
    const { adapter, core, start } = newCore()
    const { task: first, proc } = await start('write me an essay')
    const second = core.handle(ingress('and another one'))
    await flush()

    await core.handle(ingress('/stop'))
    feed(proc, INTERRUPTED.turn(1))
    await Promise.all([first, second])

    expect(posted(adapter.instructions).filter(({ kind }) => kind === 'stopped')).toEqual([
      { kind: 'stopped', conversationKey: KEY },
      { kind: 'stopped', conversationKey: KEY },
    ])
    // The second never ran: one Turn was sent, and it is the one that was
    // interrupted.
    expect(proc.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  // "Handled without error" is not the same as handled silently. Someone who
  // types `/stop` a moment after the Task they meant to stop has finished needs
  // to know that nothing was stopped — told it was, they stop watching a Task
  // that is in fact still running.
  it('says there was nothing to stop rather than nothing at all', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/stop'))
    await say('hello')
    await core.handle(ingress('/stop'))

    expect(posted(adapter.instructions).filter(({ kind }) => kind === 'command-outcome')).toEqual([
      { kind: 'command-outcome', conversationKey: KEY, command: 'stop', carriedOut: false },
      { kind: 'command-outcome', conversationKey: KEY, command: 'stop', carriedOut: false },
    ])
    expect(claude.process.sent.filter((frame) => frame['type'] === 'control_request')).toEqual([])
  })

  // `/new` cannot mean a different Conversation Key — the key is the Channel's,
  // and a DM carries the same one forever — so it means a different Session
  // under the same key. Created rather than resumed is the whole of "the old
  // context does not come with it".
  it('gives the Conversation a Session with nothing in it', async () => {
    const { adapter, claude, core, say } = newCore()
    await say('hello')

    await core.handle(ingress('/new'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY, 1))
    expect(claude.lastSpawn.args).toContain('--session-id')
    expect(claude.lastSpawn.args).not.toContain('--resume')
    expect(claude.lastSpawn.args).not.toContain(sessionIdFor(KEY))
    expect(posted(adapter.instructions).filter(({ kind }) => kind === 'command-outcome')).toEqual([
      { kind: 'command-outcome', conversationKey: KEY, command: 'new', carriedOut: true },
    ])
  })

  // Held in memory this would survive until the next deploy and then be silently
  // undone: the Conversation resumes the transcript it asked to be rid of, and
  // the only evidence is Claude Code remembering things that were supposed to be
  // gone.
  it("is still the Conversation's Session after roma has restarted", async () => {
    const first = newCore()
    await first.say('hello')
    await first.core.handle(ingress('/new'))

    const second = newCore({ workRoot: first.workRoot })
    await second.say('and now', { session: sessionIdFor(KEY, 1) })

    expect(second.claude.lastSpawn.args).toContain(sessionIdFor(KEY, 1))
    expect(second.claude.lastSpawn.args).not.toContain(sessionIdFor(KEY))
  })

  // `/new` is aimed at what the next message reaches, not at the work in flight.
  // A Task torn down here would be one nobody stopped and nobody was told about.
  it('leaves a Task that is already running to finish and answer', async () => {
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/new'))
    feed(proc, OK)
    await task

    expect(proc.signals).toEqual([])
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  // Claude Code's own slash commands are work, and there are more of them every
  // release. roma interpreting anything beyond its two would quietly swallow one
  // of them — and the person would never find out which.
  it('interprets no command string but those two', async () => {
    const { adapter, claude, say } = newCore()

    await say('/clear')

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '/clear' }] },
    })
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  // Silence is not an outcome the Core has, and that does not stop at Tasks. A
  // Conversation whose record of which Session it is on cannot be read is
  // answered, badly, rather than not at all.
  it('says so when it cannot work out which Session a Conversation is on', async () => {
    const { adapter, core, workRoot } = newCore()
    // Reaching for `SessionGenerations`' own file, because a half-written record
    // is a state nothing else can produce — a machine that lost power mid-write
    // can, and this is the only way to be in the room when it happens.
    writeFileSync(join(workRoot, `${sessionIdFor(KEY)}.generation`), 'half a wr')

    await core.handle(ingress('hello'))
    await core.handle(ingress('/new'))

    expect(posted(adapter.instructions)).toEqual([
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not run this Task.' },
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not carry out that command.' },
    ])
  })

  it('never hands a Command to Claude Code as work', async () => {
    const { claude, core, say } = newCore()
    await say('hello')

    await core.handle(ingress('/stop'))
    await core.handle(ingress('/new'))

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })
})

describe('the record every Task leaves behind', () => {
  /** A real interrupt: the aborted Turn cost $0.000625 and the capture says so. */
  const INTERRUPTED = recordedStream('interrupted-turn')

  // Per-user attribution does not exist at the provider — everybody shares one
  // token — so this file is the only place the question "who spent this" is ever
  // answerable. Nothing else in roma has both halves: the pool knows the Session
  // and the cost, and only the Core knows who asked.
  it('says who asked, which Session ran it, how long it took and what it cost', async () => {
    const { audit, say } = newCore()

    await say('hello')

    expect(recordsIn(audit)).toEqual([
      {
        at: new Date(NOW).toISOString(),
        taskId: expect.any(String),
        caller: 'someone',
        sessionId: sessionIdFor(KEY),
        outcome: 'result',
        costUsd: expect.closeTo(0.0103129, 7),
        durationMs: 0,
        turnMs: 0,
        credential: 'shared-window',
        apiKeySource: 'none',
      },
    ])
  })

  // The headline of #9 and the number ADR-0002's monthly Overflow cap is built
  // on. `total_cost_usd` is cumulative for the process, so a fifth Task logged
  // raw is recorded at the sum of Tasks one through five — and every argument
  // made from these figures would be made on numbers roughly five times too big.
  it('records five Tasks of one Session at five separate costs', async () => {
    const { audit, say } = newCore()

    // One process serving five Turns, its running total climbing as Claude Code
    // reports it.
    for (const total of [0.01, 0.02, 0.035, 0.05, 0.06]) {
      await say('hello', { events: withTotalCostUsd(OK, total) })
    }

    const costs = recordsIn(audit).map((record) => Number(record.costUsd?.toFixed(6)))
    expect(costs).toEqual([0.01, 0.01, 0.015, 0.015, 0.01])
    // The fifth Task is not the whole Session, and the five together are.
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(0.06, 6)
  })

  // Two numbers because they answer different questions. The Task's own wall
  // clock is what the person endured, queueing and cold start included; the
  // Turn's is what Claude Code was actually working for, and the difference is
  // what the concurrency cap costs.
  it('separates how long the person waited from how long the Turn took', async () => {
    const { audit, claude, core, workRoot } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()
    const proc = claude.processFor(join(workRoot, sessionIdFor(KEY)))
    // Three seconds of the second Task's life spent waiting for the first.
    await vi.advanceTimersByTimeAsync(3_000)
    feed(proc, OK)
    await first
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    feed(proc, stream.turn(3))
    await second

    expect(recordsIn(audit).at(-1)).toMatchObject({ durationMs: 4_000, turnMs: 1_000 })
  })

  it('records a Task per Task rather than a Task per Conversation', async () => {
    const { audit, say } = newCore()

    await say('hello')
    await say('hello', { key: OTHER_KEY })

    expect(recordsIn(audit).map((record) => record.sessionId)).toEqual([
      sessionIdFor(KEY),
      sessionIdFor(OTHER_KEY),
    ])
    expect(new Set(recordsIn(audit).map((record) => record.taskId)).size).toBe(2)
  })

  // A Turn that failed still reached a terminal event, so Claude Code priced it —
  // at zero here, because a 401 buys nothing. A reported zero, not an assumed one.
  it('records a Task that failed, at what the failed Turn was priced', async () => {
    const { audit, say } = newCore()

    await say('hello', { events: FAILED_OUTRIGHT })

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'failure', costUsd: 0 }])
  })

  // The opposite case, and the reason cost is nullable: the process died with the
  // Turn in flight, so whatever it had already spent is real and nothing will
  // ever name it. Recording that as zero would report money as free — the same
  // class of wrong as a cumulative total, pointing the other way.
  it('records a Task whose process died mid-Turn as unpriced rather than free', async () => {
    const { audit, claude, core } = newCore()

    const task = core.handle(ingress('hello'))
    await flush()
    claude.process.emitExit({ code: 1, signal: null })
    await task

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'failure', costUsd: null }])
    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 1, costUsd: 0, unpriced: 1 })
  })

  it('records a Task somebody stopped, at what the interrupted Turn had spent', async () => {
    const { audit, core, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))
    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'stopped', costUsd: 0.000625 }])
  })

  // Stopped while it was still queued, so there is no Turn to have cost
  // anything. It is still a Task somebody sent and still one the log has to
  // account for, and its duration is the only one it has.
  it('records a Task that was stopped before it ever reached Claude Code', async () => {
    const { audit, claude, core, workRoot } = newCore()
    const busy = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const waiting = core.handle(ingress('a long job', 'four'))
    await flush()

    await core.handle(ingress('/stop', 'four'))
    for (const key of ['one', 'two', 'three']) {
      feed(claude.processFor(join(workRoot, sessionIdFor(key))), OK)
    }
    await Promise.all(busy)
    await waiting

    expect(recordsIn(audit).find((record) => record.sessionId === sessionIdFor('four'))).toMatchObject(
      { outcome: 'stopped', costUsd: 0, turnMs: null },
    )
  })

  // roma stopped waiting rather than Claude Code finishing, so no terminal event
  // arrived and nothing ever priced the Turn. Unpriced rather than free: the
  // retries were probably 401s that bought nothing, but "probably" is not a
  // number, and a cap is entitled to know its total is a floor.
  it('records a Task abandoned mid-retry-storm as unpriced', async () => {
    const { audit, start } = newCore({ retryBudget: { maxApiRetries: 3, windowMs: 60_000 } })

    const { task, proc } = await start('hello')
    feed(proc, RETRIES.slice(0, 3))
    await task

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'failure', costUsd: null, turnMs: null }])
  })

  // A Command is not a Task: it drives no Turn, costs nothing, and is not queued
  // or counted. Recording one would put rows in the log that no money belongs to
  // and inflate every count taken off it.
  it('records nothing for a Command', async () => {
    const { audit, core, say } = newCore()

    await say('hello')
    await core.handle(ingress('/stop'))
    await core.handle(ingress('/new'))

    expect(recordsIn(audit)).toHaveLength(1)
  })

  // The record is written before the Channel is told, because those are two
  // different obligations and only one of them can be met by trying again. A
  // Task whose result never reached anybody still spent the money.
  it('records a Task whose outcome the Channel never took', async () => {
    const shared = newCore()
    const { audit, claude, workRoot } = shared
    const core = coreOver(
      shared,
      channelThat(() => {
        throw new Error('the Channel is down')
      }),
    )

    const task = core.handle(ingress('hello'))
    task.catch(() => {})
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await expect(task).rejects.toThrow('the Channel is down')

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'result', costUsd: expect.closeTo(0.0103129, 7) }])
  })

  // Both halves, because they can disagree and the disagreement is the whole
  // point. ADR-0002's worst silent failure is a stray ANTHROPIC_API_KEY moving
  // every run onto metered billing: roma believes it is spending quota, the
  // invoice says otherwise, and this field is the only evidence either way.
  it('records what roma ran the Task on and what Claude Code says paid for it', async () => {
    const { audit, say } = newCore()

    await say('hello', { events: withApiKeySource(OK, 'ANTHROPIC_API_KEY') })

    expect(recordsIn(audit)).toMatchObject([
      { credential: 'shared-window', apiKeySource: 'ANTHROPIC_API_KEY' },
    ])
    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 1, mismatched: 1 })
  })
})

describe('when the Shared Window is spent', () => {
  // ADR-0002: say plainly that quota is spent, quote the reset time, and keep
  // the Task. The reset time comes off the event rather than being estimated,
  // which is the whole reason it is worth quoting.
  it('says the window is spent and when it comes back', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'blocked',
      conversationKey: KEY,
      resetsAt: RESETS_AT,
      overflowOffered: false,
    })

    leftParked(task)
  })

  // Queued rather than dropped, and holding nothing while it waits: a Task
  // parked for three hours that kept its concurrency slot would halt roma with
  // two more like it.
  it('keeps the Task without holding a slot while it waits', async () => {
    const { queue, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()

    expect(queue.running).toBe(0)
    expect(queue.waiting).toBe(0)

    leftParked(task)
  })

  // The Task the window blocked is the Task that runs when it comes back — same
  // message, same Session, one answer to the person who asked.
  it('runs the Task again when the window resets, and answers it', async () => {
    const { adapter, claude, workRoot, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  // One Task, one record, however many attempts it took.
  it('leaves one Audit Record for a Task that was blocked and then ran', async () => {
    const { audit, claude, workRoot, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(recordsIn(audit)).toHaveLength(1)
    expect(recordsIn(audit)[0]).toMatchObject({ outcome: 'result', credential: 'shared-window' })
  })

  // A person watching a Task that has been told to wait three hours is exactly
  // the person who will stop it, and there is no Turn to interrupt.
  it('lets a parked Task be stopped rather than waiting out the window', async () => {
    const { adapter, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await core.handle(ingress('/stop'))
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({ kind: 'stopped', conversationKey: KEY })
  })

  // A window roma is told is spent and not told when it comes back is one it
  // cannot park against: the Task would wait for a moment that never arrives.
  it('fails the Task rather than parking it against a reset it was not told', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, [quotaEvent({ status: 'blocked', resetsAt: null }), ...FAILED_OUTRIGHT])
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'failure' })
  })
})

describe('offering Overflow, and taking it', () => {
  // Asked of the event: the provider has the last word, and offering a valve it
  // will refuse spends somebody's attention on a button that then fails.
  it('offers Overflow only where the event says overage is available', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      kind: 'blocked',
      overflowOffered: true,
    })

    leftParked(task)
  })

  it('does not offer it where roma has no metered credential configured', async () => {
    const { adapter, start } = newCore({ overflow: null })

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ overflowOffered: false })

    leftParked(task)
  })

  // The rerun is the same Task on the same Session, on the other environment
  // map. ADR-0002: Overflow is not a mode, and the Session's context comes with
  // it — otherwise the answer would not be to the question that was asked.
  it('reruns the blocked Task on the metered credential', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    expect(await core.takeOverflow(taskIdOf(adapter))).toBe(true)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(claude.lastSpawn.args).toContain('--resume')
    // Whose money it was is the audit record's whole job.
    expect(recordsIn(audit)).toMatchObject([{ credential: 'overflow', outcome: 'result' }])
  })

  it('shows what the Overflow Turn spent, in the reply', async () => {
    const { adapter, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'result',
      overflowCostUsd: expect.closeTo(0.0103129, 7),
    })
  })

  // It applies to that Task and to nothing else. A Conversation left on metered
  // billing is the persistent toggle ADR-0002 refuses, arrived at by accident.
  it('leaves the next Task in the Conversation on the Shared Window', async () => {
    const { adapter, claude, workRoot, core, start, say } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task
    await say('and another', { events: stream.turn(3) })

    expect(claude.lastSpawn.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
  })

  // Anyone may take it, but only while there is something to take: an offer on a
  // Task that has since run, been stopped, or never existed is not one roma can
  // act on, and saying so is the Adapter's business rather than a silent no-op.
  it('says there was no offer to take when the Task is no longer waiting', async () => {
    const { core, say } = newCore()

    await say('hello')

    expect(await core.takeOverflow('a-task-that-is-over')).toBe(false)
  })
})

describe('a Task that is blocked more than once', () => {
  /** Run a parked Task again, whichever wait it is on. */
  async function letTheWindowReset(waitMs = UNTIL_RESET) {
    await vi.advanceTimersByTimeAsync(waitMs)
    await flush()
  }

  // The reading has to be this attempt's own. Kept from an earlier one, its
  // `resetsAt` has already passed — so a later failure carrying no reading of
  // its own would park against a moment in the past, rerun instantly, fail, and
  // spin as fast as Claude Code can start, announcing itself every pass.
  it('does not park again on a failure the window had nothing to do with', async () => {
    const { adapter, claude, workRoot, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await letTheWindowReset()
    // The rerun fails saying nothing at all about the window.
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), FAILED_OUTRIGHT)
    await task

    expect(adapter.instructions.filter(({ kind }) => kind === 'blocked')).toHaveLength(1)
    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('401'),
    })
  })

  // A parked Task holds no slot, so this is not the halted-bot risk — it is that
  // a third "still blocked" message lands on a Conversation that stopped
  // watching hours ago, and that a Task which never ends is one nobody can be
  // told anything about.
  it('answers the Task rather than holding it through a third window', async () => {
    const { adapter, claude, workRoot, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await letTheWindowReset()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), BLOCKED)
    await flush()
    // The reset time has passed by now, so this park is the floor rather than
    // the window's own time.
    await letTheWindowReset(60_000)
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), BLOCKED)
    await task

    expect(adapter.instructions.filter(({ kind }) => kind === 'blocked')).toHaveLength(2)
    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'failure' })
  })
})

describe('what Overflow is taken for', () => {
  /** The blocked attempt, priced — a window that ran out with work already done. */
  const BLOCKED_HAVING_SPENT = withTotalCostUsd(BLOCKED_WITH_OVERAGE, 0.02)

  // The attempt, not the Task. Left on the metered credential, a Task that took
  // Overflow and then failed would go on spending metered money with nobody
  // asked and no cap consulted.
  it('goes back to the Shared Window for the next attempt of the same Task', async () => {
    const { adapter, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    // The metered attempt is blocked too, so the Task parks a second time.
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), BLOCKED_WITH_OVERAGE)
    await flush()
    expect(claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })

    // No time has passed, so this park is still waiting on the window's own
    // reset rather than on the floor.
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(claude.lastSpawn.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
  })

  // Which credential answered is the order the attempts happened in, not the
  // order the credentials first appeared. A Task that tried the Shared Window,
  // was sold Overflow, was blocked on that too, and was finally answered by the
  // window coming back is a Shared Window Task — filed under Overflow it reports
  // a metered Task that produced nothing, which is the one question an Audit
  // Record exists to answer.
  it('files the Task under the credential that answered, not the one that only tried', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    // The metered attempt is blocked too, so the Task parks a second time.
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), BLOCKED_WITH_OVERAGE)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    // One record, on the subscription. Neither blocked attempt was priced, so
    // Overflow has no spend of its own to account for and earns no second record.
    expect(recordsIn(audit).map((record) => record.credential)).toEqual(['shared-window'])
  })

  // The money the window refused is the subscription's, and it is charged to the
  // subscription. Summed into the Overflow figure it would refuse other people's
  // work over money nobody spent on a card — and would be shown to the person
  // who asked as what their decision cost them.
  it('bills the blocked attempt to the credential that was actually paying', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_HAVING_SPENT)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(audit.totalFor(MONTH, 'overflow')).toMatchObject({
      tasks: 1,
      costUsd: expect.closeTo(0.0103129, 7),
    })
    expect(audit.totalFor(MONTH, 'shared-window')).toMatchObject({
      tasks: 1,
      costUsd: expect.closeTo(0.02, 7),
    })
    // And the reply prices the decision somebody made, not the whole Task.
    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'result',
      overflowCostUsd: expect.closeTo(0.0103129, 7),
    })
  })

  // Both records name the same Task, because it is one Task. What differs is
  // which bill each part of it landed on.
  it('files the two halves under one Task id', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_HAVING_SPENT)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    const records = recordsIn(audit)
    expect(records.map((record) => record.credential)).toEqual(['overflow', 'shared-window'])
    expect(new Set(records.map((record) => record.taskId)).size).toBe(1)
  })
})

describe('the monthly Overflow cap', () => {
  /** Records enough Overflow spend into the month to sit at `usd`. */
  function alreadySpent(audit: AuditLog, usd: number) {
    audit.record({
      taskId: 'earlier',
      caller: 'someone',
      sessionId: sessionIdFor('another'),
      outcome: 'result',
      costUsd: usd,
      durationMs: 1_000,
      turnMs: 1_000,
      credential: 'overflow',
      apiKeySource: 'ANTHROPIC_API_KEY',
    })
  }

  // Without a cap, "off by default" is ceremony rather than protection.
  it('refuses Overflow past the cap and says what the cap was', async () => {
    const { adapter, audit, core, start } = newCore({ overflow: { monthlyCapUsd: 5 } })
    alreadySpent(audit, 5.5)

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'overflow-refused',
      conversationKey: KEY,
      capUsd: 5,
      spentUsd: 5.5,
    })

    leftParked(task)
  })

  // Refused, not abandoned. The window still comes back, and the Task is still
  // the one that was blocked.
  it('leaves the refused Task waiting for the window rather than ending it', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore({
      overflow: { monthlyCapUsd: 5 },
    })
    alreadySpent(audit, 5.5)

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result' })
  })

  // The owner finds out where operators look. The person who asked is told they
  // were refused; the number that says roma is spending more than it was meant
  // to is not theirs to act on.
  it('writes the refusal down for an operator', async () => {
    const { adapter, audit, core, log, start } = newCore({ overflow: { monthlyCapUsd: 5 } })
    alreadySpent(audit, 5.5)

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()

    expect(log).toContainEqual(
      expect.objectContaining({ event: 'overflow-refused', capUsd: 5, spentUsd: 5.5 }),
    )

    leftParked(task)
  })

  // The total is the sum of per-Turn deltas, which is the whole of #9's
  // argument: read off cumulative Session totals, a cap of five dollars would be
  // reached at a fraction of five dollars actually spent.
  it('is measured on per-Turn costs, so spend below it is still allowed', async () => {
    const { adapter, audit, claude, workRoot, core, start } = newCore({
      overflow: { monthlyCapUsd: 5 },
    })
    alreadySpent(audit, 1)

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result' })
    expect(audit.totalFor(MONTH, 'overflow')).toMatchObject({ tasks: 2 })
  })
})

describe('knowing nothing about which Channel a message came from', () => {
  it('refuses a Channel that cannot supply a stable Conversation Key', () => {
    const shared = newCore()
    const adapter = new RecordingAdapter({ stableConversationKey: false })

    expect(() => coreOver(shared, adapter)).toThrow(/stable/i)
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
function coreSources(): Source[] {
  return sources().filter(({ file }) => !file.split(sep).includes('channels'))
}
