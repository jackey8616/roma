import { appendFileSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLog, monthOf } from './audit-log.js'
import { commandSpellings, readCommand } from './commands.js'
import { Core, type CoreLogRecord, type CoreOptions } from './core.js'
import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
  PendingEnclosure,
  Quotation,
} from './channel-adapter.js'
import { apiKeySourceFor, type CredentialKind } from './build-env.js'
import { CAVEMAN_NAMES, CAVEMAN_NOT_PINNED, CAVEMAN_OFF, cavemanRuleset } from './caveman.js'
import { PINNED_EFFORT, PINNED_MODEL } from './claude-session.js'
import { EFFORT_NOT_APPLIED } from './effort-menu.js'
import type { RetryBudget } from './config.js'
import { RUNTIME_NAMES, RUNTIMES, type Runtime } from './runtime.js'
import {
  chosenCavemen,
  chosenEfforts,
  chosenModels,
  SessionGenerations,
} from './session-generation.js'
import { sessionIdFor } from './session-id.js'
import { SessionPool, type PoolLogRecord } from './session-pool.js'
import { WorkRoot } from './work-root.js'
import type { ClaudeEvent } from './stream-events.js'
import { TaskQueue } from './task-queue.js'
import { flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { romaFixture, teardownRoma, type RomaFixture } from '../test/support/roma-fixture.js'
import {
  BLOCKED,
  BLOCKED_WITH_OVERAGE,
  COMPACTED,
  COMPACTED_MANUALLY,
  COMPACTION_FAILED,
  MANUAL_COMPACTION_REFUSED,
  NEARLY_SPENT,
  FAILED,
  FAILED_OUTRIGHT,
  feed,
  GENERATING,
  ofKind,
  OK,
  quotaEvent,
  recordedStream,
  RESUME_LOST,
  RETRIES,
  THREE_TURNS,
  upToFirst,
  withApiKeySource,
  withCompactionError,
  withoutCompactionTokens,
  withResultText,
  withTotalCostUsd,
} from '../test/support/recorded-stream.js'
import { sources, type Source } from '../test/support/sources.js'

const RESETS_AT = 1785271200
const TOOL_STARTS = upToFirst(
  recordedStream('tool-use-partial-messages').turn(1),
  'system/task_started',
)

const THROTTLE = 5_000

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

const UNTIL_RESET = 60 * 60_000
const NOW = RESETS_AT * 1000 - UNTIL_RESET
const MONTH = monthOf(new Date(NOW))

let pools: SessionPool[] = []
let fixtures: RomaFixture[] = []

const EVERY_CORE_OPTION: Record<keyof CoreOptions, true> = {
  channel: true,
  pool: true,
  workRoot: true,
  queue: true,
  sessions: true,
  models: true,
  efforts: true,
  cavemen: true,
  cavemanPinned: true,
  audit: true,
  credential: true,
  overflow: true,
  usedCloudReach: true,
  usedDocumentReach: true,
  log: true,
}

function newCore({
  workRoot: existingWorkRoot,
  overflow = { monthlyCapUsd: 100 },
  capabilities,
  pinnedModel = PINNED_MODEL,
  pinnedCaveman,
  ...options
}: {
  workRoot?: string
  overflow?: { monthlyCapUsd: number } | null
  retryBudget?: RetryBudget
  capabilities?: Partial<ChannelCapabilities>
  pinnedModel?: string
  pinnedCaveman?: string
  usedCloudReach?: (taskId: string) => boolean
  usedDocumentReach?: (taskId: string) => boolean
} = {}) {
  const fixture = romaFixture(
    'core',
    existingWorkRoot === undefined ? {} : { workRoot: existingWorkRoot },
  )
  fixtures.push(fixture)
  const { claude, procFor, procIn } = fixture
  const { workRoot, auditRoot } = fixture.dirs
  const work = new WorkRoot(workRoot)
  const models = chosenModels({ workRoot: work, pinnedModel })
  const efforts = chosenEfforts({ workRoot: work, pinnedEffort: PINNED_EFFORT })
  const cavemen = chosenCavemen({ workRoot: work, pinnedCaveman: pinnedCaveman ?? CAVEMAN_OFF })
  const poolLog: PoolLogRecord[] = []
  const pool = new SessionPool({
    workRoot: work,
    models,
    efforts,
    cavemen,
    envs: {
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
    log: (record) => poolLog.push(record),
    ...(options.retryBudget === undefined ? {} : { retryBudget: options.retryBudget }),
  })
  pools.push(pool)

  const queue = new TaskQueue()
  const sessions = new SessionGenerations({ workRoot: work })
  const adapter = new RecordingAdapter(capabilities)
  const audit = new AuditLog({ auditRoot })
  const log: CoreLogRecord[] = []
  const core = new Core({
    channel: adapter,
    pool,
    workRoot: work,
    queue,
    sessions,
    models,
    efforts,
    cavemen,
    cavemanPinned: pinnedCaveman !== undefined,
    audit,
    credential: 'shared-window',
    log: (record) => log.push(record),
    ...(overflow === null ? {} : { overflow }),
    ...(options.usedCloudReach === undefined ? {} : { usedCloudReach: options.usedCloudReach }),
    ...(options.usedDocumentReach === undefined
      ? {}
      : { usedDocumentReach: options.usedDocumentReach }),
  })

  const say = async (
    text: string,
    {
      key = KEY,
      events = OK,
      session = sessionIdFor(key),
      who,
    }: {
      key?: string
      events?: readonly ClaudeEvent[]
      session?: string
      who?: { caller: string; callerName: string | null }
    } = {},
  ): Promise<void> => {
    const task = core.handle(ingress(text, key, who))
    await flush()
    feed(procIn(session), events)
    await task
  }

  const start = async (
    text: string,
    key = KEY,
  ): Promise<{ task: Promise<void>; proc: FakeClaudeProcess }> => {
    const task = core.handle(ingress(text, key))
    task.catch(() => {})
    await flush()
    return { task, proc: procFor(key) }
  }

  return {
    adapter,
    audit,
    auditRoot,
    cavemen,
    claude,
    core,
    efforts,
    log,
    models,
    pool,
    poolLog,
    queue,
    sessions,
    work,
    workRoot,
    procFor,
    say,
    start,
  }
}

function leftParked(task: Promise<void>): void {
  void task
}

function taskIdOf(adapter: RecordingAdapter): string {
  const instruction = adapter.instructions.at(-1)
  if (instruction === undefined) throw new Error('the Channel has been told nothing')
  return instruction.taskId
}

function recordsIn(audit: AuditLog) {
  return audit.readMonth(MONTH)
}

function coreOver(shared: ReturnType<typeof newCore>, channel: ChannelAdapter): Core {
  return new Core({
    channel,
    pool: shared.pool,
    workRoot: shared.work,
    queue: shared.queue,
    sessions: shared.sessions,
    models: shared.models,
    efforts: shared.efforts,
    cavemen: shared.cavemen,
    audit: shared.audit,
    credential: 'shared-window',
  })
}

function channelThat(deliver: ChannelAdapter['deliver']): ChannelAdapter<IngressMessage> {
  return {
    capabilities: { messageMutation: true, stableConversationKey: true },
    toIngress: (event: IngressMessage) => event,
    deliver,
  }
}

function ingress(
  text: string,
  conversationKey = KEY,
  who: { caller: string; callerName: string | null } = { caller: 'users/17', callerName: 'Ada' },
): IngressMessage {
  return { conversationKey, ...who, text, enclosures: [], quotation: null }
}

const BOB = { caller: 'users/99', callerName: 'Bob' }

function posted(instructions: readonly OutboundInstruction[]) {
  return instructions.map(({ taskId, caller, callerName, ...rest }) => rest)
}

function opening(key = KEY) {
  return { kind: 'result', conversationKey: key, text: expect.stringContaining(PINNED_MODEL) }
}

const OPENS_WITH = 'This conversation is on'

const SETTINGS_WITHOUT_A_CAVEMAN =
  `This conversation is on default (${PINNED_MODEL}), at default (${PINNED_EFFORT}). ` +
  `Change either with “/model” or “/effort”.`
const SETTINGS_AT_A_PINNED_CAVEMAN =
  `This conversation is on default (${PINNED_MODEL}), at default (${PINNED_EFFORT}), ` +
  `at caveman default (full). Change any with “/model”, “/effort” or “/caveman”.`

function openingsIn(instructions: readonly OutboundInstruction[]) {
  return instructions.filter(
    (instruction) => instruction.kind === 'result' && instruction.text.startsWith(OPENS_WITH),
  )
}

function refusingTheOpening(shared: ReturnType<typeof newCore>) {
  const delivered: OutboundInstruction[] = []
  let refused = false
  const core = coreOver(
    shared,
    channelThat((instruction) => {
      if (!refused && instruction.kind === 'result') {
        refused = true
        return Promise.reject(new Error('the Channel is down'))
      }
      delivered.push(instruction)
    }),
  )
  const say = async (text: string, { events = OK }: { events?: readonly ClaudeEvent[] } = {}) => {
    const task = core.handle(ingress(text))
    await flush()
    feed(shared.procFor(KEY), events)
    await task
  }
  return { core: { say }, delivered }
}

function progressOf(adapter: RecordingAdapter) {
  return adapter.instructions.filter((instruction) => instruction.kind === 'progress')
}

function queuedIn(adapter: RecordingAdapter) {
  return progressOf(adapter).filter((instruction) => instruction.progress.phase === 'queued')
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: NOW,
  })
})

afterEach(async () => {
  await teardownRoma(
    pools,
    fixtures.flatMap(({ roots }) => roots),
  )
  pools = []
  fixtures = []
  vi.useRealTimers()
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
    await say('second', { events: THREE_TURNS.turn(3) })

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

  it('reaches the same Session from a roma that remembers nothing', async () => {
    const first = newCore()
    await first.say('hello')
    const second = newCore()

    await second.say('hello')

    expect(second.claude.lastSpawn.args).toEqual(first.claude.lastSpawn.args)
  })
})

describe('what the Channel is asked to post', () => {
  it('acknowledges the Task, then posts the result as its own message', async () => {
    const { adapter, say } = newCore()

    await say('hello')

    expect(posted(adapter.instructions)).toEqual([
      opening(),
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
    ).toEqual([KEY, KEY, OTHER_KEY, OTHER_KEY])
  })

  it('says so when a Turn fails, rather than going quiet', async () => {
    const { adapter, say } = newCore()

    await say('hello', { events: FAILED })

    expect(posted(adapter.instructions)).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'failure', conversationKey: KEY, reason: expect.stringContaining('401') },
    ])
  })

  it("says so when the Session could not run at all, in roma's own words [fence:core-failure-in-romas-words]", async () => {
    const why =
      "A failure on roma's side is told in roma's words, never the error's own message " +
      '(ADR-0010): those carry exit codes and Session uuids a Caller has never seen and ' +
      "cannot act on; the detail is the operator's."
    const { adapter, claude, core } = newCore()

    const task = core.handle(ingress('hello'))
    await flush()
    claude.process.emitExit({ code: 1, signal: null })
    await task

    expect(posted(adapter.instructions), why).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not run this Task.' },
    ])
  })

  it('tells a Conversation whose Session cannot be opened what to do about it [fence:core-session-lost-reason]', async () => {
    const why =
      'A Session that cannot be opened is answered with /clear, never a promise that ' +
      "resending works and never Claude Code's own sentence (#107): the pool has " +
      'already retried, and No conversation found with session ID names an id the ' +
      'Caller has never seen.'
    const { adapter, claude, core, pool, procFor, say } = newCore()
    await say('first')
    await pool.evict(sessionIdFor(KEY))

    const task = core.handle(ingress('hello'))
    await flush()
    feed(procFor(KEY), RESUME_LOST)
    await flush()
    feed(procFor(KEY), RESUME_LOST)
    await task

    expect(claude.spawns, why).toHaveLength(3)
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('/clear'),
    })
    expect(posted(adapter.instructions).at(-1), why).not.toMatchObject({
      reason: 'roma could not run this Task.',
    })
    const [told] = posted(adapter.instructions).slice(-1)
    const reason = told?.kind === 'failure' ? told.reason : ''
    expect(reason, why).not.toMatch(/again|no conversation found/i)
    expect(reason, why).not.toContain(sessionIdFor(KEY))
  })

  it('does not also throw a failure it has already reported', async () => {
    const { say } = newCore()

    await expect(say('hello', { events: FAILED })).resolves.toBeUndefined()
  })

  it('does not swallow an instruction the Channel never carried out', async () => {
    const shared = newCore()
    const { procFor } = shared
    const core = coreOver(
      shared,
      channelThat(() => {
        throw new Error('the Channel is down')
      }),
    )

    const task = core.handle(ingress('hello'))
    await flush()
    feed(procFor(KEY), OK)

    await expect(task).rejects.toThrow('the Channel is down')
  })
})

describe('handling one Conversation one Task at a time', () => {
  it('does not send a second message while the first Task is still running', async () => {
    const { claude, core, procFor } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()
    const proc = procFor(KEY)

    expect(claude.processes).toHaveLength(1)
    expect(proc.sent).toHaveLength(1)

    feed(proc, OK)
    await first
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await second

    expect(proc.sent).toHaveLength(2)
  })

  it('answers both, in the order they arrived', async () => {
    const { adapter, core, procFor } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()
    const proc = procFor(KEY)
    feed(proc, OK)
    await first
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await second

    expect(
      posted(adapter.instructions.filter((instruction) => instruction.kind === 'result')),
    ).toEqual([
      opening(),
      { kind: 'result', conversationKey: KEY, text: 'ok' },
      { kind: 'result', conversationKey: KEY, text: '47' },
    ])
  })

  it('tells the second caller it is waiting rather than leaving it silent', async () => {
    const { adapter, core, procFor } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()

    expect(posted(adapter.instructions)).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'queued', position: 1 } },
    ])
    expect(new Set(progressOf(adapter).map((instruction) => instruction.taskId)).size).toBe(2)

    const proc = procFor(KEY)
    feed(proc, OK)
    await first
    await flush()
    feed(proc, THREE_TURNS.turn(3))
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

  it('still runs a Task whose caller could not be told anything about it', async () => {
    const shared = newCore()
    const { core: first, procFor } = shared
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

    const proc = procFor(KEY)
    feed(proc, OK)
    await running
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await behind

    expect(posted(delivered)).toEqual([{ kind: 'result', conversationKey: KEY, text: '47' }])
  })

  it('does not extend that to the result of a Task that waited', async () => {
    const shared = newCore()
    const { core: first, procFor } = shared
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

    const proc = procFor(KEY)
    feed(proc, OK)
    await running
    await flush()
    feed(proc, THREE_TURNS.turn(3))

    await expect(behind).rejects.toThrow('the Channel is down')
  })
})

describe('giving up on a Task that is only retrying', () => {
  const retryBudget = { maxApiRetries: 3, windowMs: 60_000 }

  it('surfaces what the retries were failing on, rather than waiting them out', async () => {
    const { adapter, start } = newCore({ retryBudget })

    const { task, proc } = await start('hello')
    feed(proc, RETRIES.slice(0, 3))
    await task

    expect(posted(adapter.instructions)).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      {
        kind: 'failure',
        conversationKey: KEY,
        reason: 'roma gave up after 3 API retries (401 authentication_failed).',
      },
    ])
  })

  it('takes new work while three Tasks are all stuck on a bad credential', async () => {
    const { adapter, claude, core, procFor } = newCore({ retryBudget })

    const stormed = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const fourth = core.handle(ingress('is anyone there?', 'four'))
    await flush()

    expect(claude.processes).toHaveLength(3)
    expect(posted(queuedIn(adapter))).toEqual([
      { kind: 'progress', conversationKey: 'four', progress: { phase: 'queued', position: 1 } },
    ])

    for (const proc of claude.processes) feed(proc, RETRIES.slice(0, 3))
    await Promise.all(stormed)
    await flush()
    feed(procFor('four'), OK)
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
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
    ])

    feed(proc, OK)
    await task
  })

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

  it('moves the acknowledgement on as the answer grows [fence:core-writing-progress-moves]', async () => {
    const why =
      'The writing phase carries how much has been written, and an update that says more ' +
      'is sent (ADR-0010): compared on the phase alone, every moment of a generating Turn ' +
      'says the same as the last and the Acknowledgement freezes, which is what a dead ' +
      'Task looks like.'
    const { adapter, start } = newCore()
    const { task, proc } = await start('hello')
    const half = Math.floor(GENERATING.length / 2)

    feed(proc, GENERATING.slice(0, half))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    feed(proc, GENERATING.slice(half, -1))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    const written = progressOf(adapter).flatMap(({ progress }) =>
      progress.phase === 'writing' ? [progress.characters] : [],
    )
    feed(proc, GENERATING.slice(-1))
    await task

    expect(written, why).toHaveLength(2)
    expect(written[1]! > written[0]!, why).toBe(true)
  })

  it('does not turn a burst of stream events into a burst of updates', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await flush()

    expect(progressOf(adapter)).toHaveLength(1)

    feed(proc, GENERATING.slice(-1))
    await task
  })

  it('sends no update after the answer, however slow the Channel is [fence:core-no-update-after-the-answer]', async () => {
    const why =
      "No progress follows a Task's last instruction (ADR-0010): ProgressReporter.stop " +
      'drops updates still queued behind a slow Channel, because an Adapter drops its ' +
      'acknowledgement with the result and a late update posts a stale Working… under ' +
      'the answer. A guarantee the Core keeps, not a rule every Adapter must be told.'
    const { adapter, start } = newCore()
    const release = adapter.hold('progress')

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await vi.advanceTimersByTimeAsync(THROTTLE)
    feed(proc, GENERATING.slice(-1))
    await task

    release()
    await flush()

    const kinds = adapter.instructions.map((instruction) => instruction.kind)
    expect(kinds.slice(kinds.lastIndexOf('result')), why).toEqual(['result'])
  })

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

  it('degrades to the acknowledgement alone where the Channel cannot edit', async () => {
    const { adapter, start } = newCore({ capabilities: { messageMutation: false } })

    const { task, proc } = await start('hello')
    feed(proc, GENERATING.slice(0, -1))
    await vi.advanceTimersByTimeAsync(20 * THROTTLE)
    feed(proc, GENERATING.slice(-1))
    await task

    expect(posted(adapter.instructions)).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'result', conversationKey: KEY, text: expect.any(String) },
    ])
  })

  it('posts the result even where the Channel never finishes taking an update', async () => {
    const shared = newCore()
    const { procFor } = shared
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
    feed(procFor(KEY), OK)
    await task

    expect(posted(delivered)).toEqual([
      opening(),
      { kind: 'result', conversationKey: KEY, text: 'ok' },
    ])
  })

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

describe('the Commands roma answers itself', () => {
  const INTERRUPTED = recordedStream('interrupted-turn')

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

  it('reports a stopped Task as stopped [fence:core-stop-reported-as-stopped]', async () => {
    const why =
      'A Task ended by /stop must be reported as stopped, neither a failure nor a silent ' +
      'completion (ADR-0003). As a failure it reads as roma breaking and carries the ' +
      'half-written answer the interrupt cut off as its reason; with nothing said, somebody ' +
      'waits for a result that is never coming.'
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))
    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions), why).toEqual([
      opening(),
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'command-outcome', conversationKey: KEY, command: 'stop', carriedOut: true },
      { kind: 'stopped', conversationKey: KEY },
    ])
    const [, acknowledgement, command, stopped] = adapter.instructions
    expect(stopped?.taskId).toBe(acknowledgement?.taskId)
    expect(command?.taskId).not.toBe(acknowledgement?.taskId)
  })

  it('does not wait behind the Task it is stopping', async () => {
    const { core, queue, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/stop'))

    expect(queue.running).toBe(1)
    expect(queue.waiting).toBe(0)

    feed(proc, INTERRUPTED.turn(1))
    await task
  })

  it('gets through while roma is running as much as it runs at once', async () => {
    const { adapter, core, procFor } = newCore()
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

    feed(procFor('one'), INTERRUPTED.turn(1))
    for (const key of ['two', 'three']) {
      feed(procFor(key), OK)
    }
    await Promise.all(tasks)
  })

  it('stops the Task it was sent to stop, even after a /clear moved the Conversation [fence:core-stop-reads-running]', async () => {
    const why =
      "/stop finds a Conversation's Tasks in #running, never through the Session " +
      'generation (ADR-0013): a /clear in between moves the Conversation while the Task ' +
      'carries on, so the generation answers nothing to stop and the Task keeps ' +
      'running.'
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('write me an essay')

    await core.handle(ingress('/clear'))
    await core.handle(ingress('/stop'))

    expect(proc.sent.at(-1), why).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })

    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'stopped',
      conversationKey: KEY,
    })
  })

  it('stops a Task that has not started yet, rather than letting it run later [fence:core-stopped-before-its-turn]', async () => {
    const why =
      'A Task stopped while queued never starts its Attempt (ADR-0003, ADR-0013): ' +
      'started anyway, it spends a Turn on work somebody said they did not want and is ' +
      'then interrupted.'
    const { adapter, claude, core, procFor } = newCore()
    const busy = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const waiting = core.handle(ingress('a long job', 'four'))
    await flush()

    await core.handle(ingress('/stop', 'four'))

    for (const key of ['one', 'two', 'three']) {
      feed(procFor(key), OK)
    }
    await Promise.all(busy)
    await waiting

    expect(claude.processes, why).toHaveLength(3)
    expect(
      posted(adapter.instructions).filter(({ conversationKey }) => conversationKey === 'four'),
    ).toEqual([
      opening('four'),
      { kind: 'progress', conversationKey: 'four', progress: { phase: 'queued', position: 1 } },
      { kind: 'command-outcome', conversationKey: 'four', command: 'stop', carriedOut: true },
      { kind: 'stopped', conversationKey: 'four' },
    ])
  })

  it('answers with an outcome only to /stop and /clear [fence:core-carry-out-names-its-two]', async () => {
    const why =
      'Only /stop and /clear are carried out as an outcome; every other Command answers in ' +
      'words of its own (ADR-0003). #carryOut names the two it handles rather than taking ' +
      'whatever is left over, so a new Command cannot land in it and be answered as a ' +
      'second /stop.'
    for (const spelling of commandSpellings()) {
      const { adapter, core } = newCore()

      await core.handle(ingress(spelling))

      const command = readCommand(spelling)?.command
      const [answer] = adapter.instructions
      if (command === 'stop' || command === 'clear') {
        expect(answer, `${spelling}: ${why}`).toMatchObject({ kind: 'command-outcome', command })
      } else {
        expect(answer?.kind, `${spelling}: ${why}`).not.toBe('command-outcome')
      }
    }
  })

  it('sends a message already waiting when a /clear lands to the Session it was sent to [fence:core-session-read-in-the-try]', async () => {
    const why =
      'The Session a message goes to is read when it arrives, not when the queue admits it ' +
      '(ADR-0013): read on admission, a message already waiting when a /clear lands goes to ' +
      'the new Session instead of the one it was sent to.'
    const { adapter, claude, core, start } = newCore()
    const { task: running, proc } = await start('first')
    const queued = core.handle(ingress('second'))
    await flush()

    await core.handle(ingress('/clear'))
    feed(proc, OK)
    await running
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await queued

    expect(claude.processes, why).toHaveLength(1)
    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: '47',
    })
  })

  it('stops a Task whose process has not finished starting [fence:core-opening-travels-with-the-message]', async () => {
    const why =
      "The Opening is started in handle() and awaited only before the Task's first " +
      'instruction (ADR-0024): awaited inline, a message that opens reaches #running ' +
      "late, so a /stop sent straight after a Conversation's first message answers " +
      'nothing to stop and the Task runs on.'
    const { adapter, core, procFor } = newCore()
    const task = core.handle(ingress('write me an essay'))
    task.catch(() => {})

    await core.handle(ingress('/stop'))
    await flush()

    const proc = procFor(KEY)
    expect(
      proc.sent.map((frame) => frame['type']),
      why,
    ).toEqual(['user', 'control_request'])

    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'stopped',
      conversationKey: KEY,
    })
  })

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
    expect(proc.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

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

  it('gives the Conversation a Session with nothing in it', async () => {
    for (const spelling of ['/clear', '/reset', '/new']) {
      const { adapter, claude, core, say } = newCore()
      await say('hello')

      await core.handle(ingress(spelling))
      await say('and now', { session: sessionIdFor(KEY, 1) })

      expect(claude.lastSpawn.args, spelling).toContain(sessionIdFor(KEY, 1))
      expect(claude.lastSpawn.args, spelling).toContain('--session-id')
      expect(claude.lastSpawn.args, spelling).not.toContain('--resume')
      expect(claude.lastSpawn.args, spelling).not.toContain(sessionIdFor(KEY))
      expect(
        posted(adapter.instructions).filter(({ kind }) => kind === 'command-outcome'),
        spelling,
      ).toEqual([
        { kind: 'command-outcome', conversationKey: KEY, command: 'clear', carriedOut: true },
      ])
      expect(
        claude.processes.flatMap((proc) => proc.sent.filter((frame) => frame['type'] === 'user')),
        spelling,
      ).toHaveLength(2)
    }
  })

  it("is still the Conversation's Session after roma has restarted", async () => {
    const first = newCore()
    await first.say('hello')
    await first.core.handle(ingress('/clear'))

    const second = newCore({ workRoot: first.workRoot })
    await second.say('and now', { session: sessionIdFor(KEY, 1) })

    expect(second.claude.lastSpawn.args).toContain(sessionIdFor(KEY, 1))
    expect(second.claude.lastSpawn.args).not.toContain(sessionIdFor(KEY))
  })

  it('leaves a Task that is already running to finish and answer', async () => {
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/clear'))
    feed(proc, OK)
    await task

    expect(proc.signals).toEqual([])
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('interprets no command string but its own and the Relay list', async () => {
    const { adapter, claude, say } = newCore()

    await say('/doctor')

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '<from>Ada (users/17)</from>\n\n/doctor' }] },
    })
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('says so when it cannot work out which Session a Conversation is on [fence:core-session-read-in-the-try]', async () => {
    const why =
      'The Session a message goes to is read inside the try (ADR-0013): read outside ' +
      'it, a Conversation roma cannot resolve is answered with silence.'
    const { adapter, core, workRoot } = newCore()
    writeFileSync(join(workRoot, `${sessionIdFor(KEY)}.generation`), 'half a wr')

    await core.handle(ingress('hello'))
    await core.handle(ingress('/clear'))

    expect(posted(adapter.instructions), why).toEqual([
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not run this Task.' },
      { kind: 'failure', conversationKey: KEY, reason: 'roma could not carry out that command.' },
    ])
  })

  it('never hands a Command to Claude Code as work', async () => {
    const { claude, core, say } = newCore()
    await say('hello')

    await core.handle(ingress('/stop'))
    await core.handle(ingress('/clear'))

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })
})

describe('the model a Conversation runs on', () => {
  const OPUS = 'claude-opus-5'

  it('runs the next Task on the model somebody chose, and says so from that message on [fence:core-model-reply-says-when]', async () => {
    const why =
      'The /model reply says it applies from the next message (ADR-0014): a bare ' +
      'acknowledgement sent while a Task runs reads as having changed that Task.'
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/model opus'))
    await say('hello')

    expect(claude.lastSpawn.args, why).toContain(OPUS)
    expect(posted(adapter.instructions)[0], why).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: expect.stringContaining('from your next message'),
    })
    expect(posted(adapter.instructions)[0], why).toMatchObject({
      text: expect.stringContaining(OPUS),
    })
  })

  it('leaves a Task that is already running on the model it started under', async () => {
    const { claude, core, say, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/model opus'))
    feed(proc, OK)
    await task

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(claude.lastSpawn.args).not.toContain(OPUS)

    await say('and now')
    expect(claude.lastSpawn.args).toContain(OPUS)
  })

  it('refuses a name it does not offer, by name, and moves nothing', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/model gpt-5'))
    await say('hello')

    expect(posted(adapter.instructions)[0]).toEqual({
      kind: 'choice',
      conversationKey: KEY,
      text: expect.stringContaining('gpt-5'),
      chooses: 'model',
      options: ['fable', 'opus', 'sonnet', 'haiku', 'default'],
      refused: 'gpt-5',
    })
    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  it('reports the current model and the Menu, without a process or a Turn [fence:core-model-never-relayed]', async () => {
    const why =
      '/model is answered by roma and never reaches a process (ADR-0014): relayed, the ' +
      'choice lives in a process that ends at Eviction, Reaping or a deploy, and ' +
      'reverts at a moment nobody can see.'
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/model'))

    expect(claude.processes, why).toHaveLength(0)
    expect(posted(adapter.instructions), why).toEqual([
      {
        kind: 'choice',
        conversationKey: KEY,
        text: expect.stringContaining(PINNED_MODEL),
        chooses: 'model',
        options: ['fable', 'opus', 'sonnet', 'haiku', 'default'],
        refused: null,
      },
    ])
    const [reported] = posted(adapter.instructions)
    for (const name of ['fable', 'opus', 'sonnet', 'haiku', 'default']) {
      expect(reported, why).toMatchObject({ text: expect.stringContaining(name) })
    }
  })

  it('reports the model it was moved to, by name and by id', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/model opus'))
    await core.handle(ingress('/model'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining(`opus (${OPUS})`),
    })
  })

  it('carries no Menu on a choice that succeeded, or on a return to the default', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/model opus'))
    await core.handle(ingress('/model default'))
    await core.handle(ingress('/effort max'))
    await core.handle(ingress('/effort default'))
    await core.handle(ingress('/caveman ultra'))
    await core.handle(ingress('/caveman default'))

    for (const instruction of posted(adapter.instructions)) {
      expect(instruction).toMatchObject({ kind: 'result' })
    }
  })

  it('reports a Session moved to the Pinned Model by the name that was typed [fence:core-named-as-typed]', async () => {
    const why =
      "A Session's model is named with chosenFor, never modelFor (ADR-0014): the two " +
      'agree on the id for a Session that chose the pinned model, and naming it default ' +
      'tells the Caller an operator moving the pin takes them along.'
    const { adapter, core } = newCore()

    await core.handle(ingress('/model sonnet'))
    await core.handle(ingress('/model'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      text: expect.stringContaining(`sonnet (${PINNED_MODEL})`),
    })
    expect(posted(adapter.instructions).at(-1), why).not.toMatchObject({
      text: expect.stringContaining('default ('),
    })
  })

  it('moves a Task that was still queued when somebody chose [fence:core-ledger-names-what-ran]', async () => {
    const why =
      'The Audit Record names the model and effort a Task ran at, re-read before each ' +
      'Attempt (ADR-0014, ADR-0016): read only on arrival, a Task queued behind another ' +
      'when somebody chose is filed under what was true when it arrived, not what was ' +
      'spent.'
    const { audit, claude, core, procFor, start } = newCore()
    const { task: running, proc } = await start('a long job')
    const queued = core.handle(ingress('and this one after it'))
    await flush()

    await core.handle(ingress('/model opus'))
    await core.handle(ingress('/effort max'))
    feed(proc, OK)
    await running
    await flush()
    feed(procFor(KEY), OK)
    await queued

    expect(claude.lastSpawn.args, why).toContain(OPUS)
    expect(
      recordsIn(audit).map((record) => record.model),
      why,
    ).toEqual([PINNED_MODEL, OPUS])
    expect(
      recordsIn(audit).map((record) => record.effort),
      why,
    ).toEqual([PINNED_EFFORT, 'max'])
  })

  it('goes back to the Pinned Model on /model default, keeping the context', async () => {
    const { claude, core, say } = newCore()
    await core.handle(ingress('/model opus'))
    await say('hello')

    await core.handle(ingress('/model default'))
    await say('and now')

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY))
    expect(claude.lastSpawn.args).toContain('--resume')
  })

  it('goes back to the Pinned Model when the Conversation is cleared, deleting nothing', async () => {
    const { claude, core, models, say, workRoot } = newCore()
    await core.handle(ingress('/model opus'))
    await say('hello')

    await core.handle(ingress('/clear'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY, 1))
    expect(readdirSync(workRoot)).toContain(`${sessionIdFor(KEY)}.model`)
    expect(models.inForce(sessionIdFor(KEY))).toBe(OPUS)
  })

  it('is still in force after roma has restarted', async () => {
    const first = newCore()
    await first.core.handle(ingress('/model opus'))

    const second = newCore({ workRoot: first.workRoot })
    await second.say('hello')

    expect(second.claude.lastSpawn.args).toContain(OPUS)
  })

  it('moves only the Conversation that asked for it', async () => {
    const { claude, core, say } = newCore()

    await core.handle(ingress('/model opus'))
    await say('hello', { key: OTHER_KEY, session: sessionIdFor(OTHER_KEY) })

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(claude.lastSpawn.args).not.toContain(OPUS)
  })

  it('names the model on the Audit Record of every Task', async () => {
    const { audit, core, say } = newCore()

    await say('on the pinned model')
    await core.handle(ingress('/model opus'))
    await say('and this one is not')

    expect(recordsIn(audit).map((record) => record.model)).toEqual([PINNED_MODEL, OPUS])
  })

  it('writes the process change down as a swap, and not as an Eviction', async () => {
    const { core, poolLog, say } = newCore()
    await say('hello')

    await core.handle(ingress('/model opus'))
    await say('and now')

    expect(poolLog.filter(({ event }) => event === 'swap')).toEqual([
      {
        event: 'swap',
        sessionId: sessionIdFor(KEY),
        reason: 'model',
        from: PINNED_MODEL,
        to: OPUS,
      },
    ])
    expect(poolLog.filter(({ event }) => event === 'evict' || event === 'reap')).toEqual([])
  })

  it('treats a message that merely begins with /model as work', async () => {
    const { adapter, claude, say } = newCore()

    await say('/model the deploy as a state machine')

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: {
        content: [{ text: '<from>Ada (users/17)</from>\n\n/model the deploy as a state machine' }],
      },
    })
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })
})

describe('the effort a Conversation runs at', () => {
  const effortOf = (spawn: { args: readonly string[] }): string | undefined =>
    spawn.args[spawn.args.indexOf('--effort') + 1]

  it('runs the next Task at the effort somebody chose, and says so from that message on', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/effort max'))
    await say('hello')

    expect(effortOf(claude.lastSpawn)).toBe('max')
    expect(posted(adapter.instructions)[0]).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: expect.stringContaining('from your next message'),
    })
  })

  it('spawns at the Pinned Effort where nobody has chosen anything', async () => {
    const { claude, say } = newCore()

    await say('hello')

    expect(effortOf(claude.lastSpawn)).toBe(PINNED_EFFORT)
  })

  it('leaves a Task that is already running at the effort it started at', async () => {
    const { claude, core, say, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/effort max'))
    feed(proc, OK)
    await task

    expect(effortOf(claude.lastSpawn)).toBe(PINNED_EFFORT)

    await say('and now')
    expect(effortOf(claude.lastSpawn)).toBe('max')
  })

  it('refuses a level it does not offer, by name, and moves nothing', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/effort ludicrous'))
    await say('hello')

    expect(posted(adapter.instructions)[0]).toEqual({
      kind: 'choice',
      conversationKey: KEY,
      text: expect.stringContaining('ludicrous'),
      chooses: 'effort',
      options: ['low', 'medium', 'high', 'xhigh', 'max', 'default'],
      refused: 'ludicrous',
    })
    expect(effortOf(claude.lastSpawn)).toBe(PINNED_EFFORT)
    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  it('refuses ultracode from a Caller, like any other name it does not offer [fence:core-ultracode-refused-as-a-typo]', async () => {
    const why =
      'ultracode is refused in exactly the words a typo is (ADR-0016): any sentence of its ' +
      "own would tell a Caller it exists and is the operator's, which is roma advertising " +
      'something no Caller can have.'
    const { adapter, claude, core } = newCore()
    await core.handle(ingress('/effort ludicrous'))
    const typo = posted(adapter.instructions).at(-1)

    await core.handle(ingress('/effort ultracode'))

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      ...typo,
      refused: 'ultracode',
      text: (typo as { text: string }).text.replace('ludicrous', 'ultracode'),
    })

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      kind: 'choice',
      refused: 'ultracode',
    })
    expect(posted(adapter.instructions).at(-1)).not.toMatchObject({
      options: expect.arrayContaining(['ultracode']),
    })
    expect(claude.processes).toHaveLength(0)
  })

  it('reports the current effort and the Menu, without a process or a Turn', async () => {
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/effort'))

    expect(claude.processes).toHaveLength(0)
    const [reported] = posted(adapter.instructions)
    expect(reported).toMatchObject({
      kind: 'choice',
      chooses: 'effort',
      options: ['low', 'medium', 'high', 'xhigh', 'max', 'default'],
      refused: null,
    })
    for (const name of ['low', 'medium', 'high', 'xhigh', 'max', 'default']) {
      expect(reported).toMatchObject({ text: expect.stringContaining(name) })
    }
  })

  it('reports a Session moved to the Pinned Effort by the name that was typed [fence:core-named-as-typed]', async () => {
    const why =
      "A Session's effort is named with chosenFor, never effortFor (ADR-0016): the two " +
      'agree on the string for a Session that chose the pinned level, and naming it ' +
      'default tells the Caller an operator moving ROMA_EFFORT takes them along.'
    const { adapter, core } = newCore()

    await core.handle(ingress(`/effort ${PINNED_EFFORT}`))
    await core.handle(ingress('/effort'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      text: expect.stringContaining(`runs at ${PINNED_EFFORT}.`),
    })
  })

  it('reports a Session nobody moved as following the Pinned Effort', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/effort'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining(`default (${PINNED_EFFORT})`),
    })
  })

  it('goes back to the Pinned Effort on /effort default, keeping the context', async () => {
    const { claude, core, say } = newCore()
    await core.handle(ingress('/effort max'))
    await say('hello')

    await core.handle(ingress('/effort default'))
    await say('and now')

    expect(effortOf(claude.lastSpawn)).toBe(PINNED_EFFORT)
    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY))
  })

  it('goes back to the Pinned Effort when the Conversation is cleared, deleting nothing', async () => {
    const { claude, core, efforts, say, workRoot } = newCore()
    await core.handle(ingress('/effort max'))
    await say('hello')

    await core.handle(ingress('/clear'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    expect(effortOf(claude.lastSpawn)).toBe(PINNED_EFFORT)
    expect(readdirSync(workRoot)).toContain(`${sessionIdFor(KEY)}.effort`)
    expect(efforts.inForce(sessionIdFor(KEY))).toBe('max')
  })

  it('treats a message that merely begins with /effort as work', async () => {
    const { claude, say } = newCore()

    await say('/effort to make the deploy faster')

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })
})

describe('an effort the model will not use', () => {
  const HAIKU = 'claude-haiku-4-5'

  it('lets the Caller set it, and says it will not apply', async () => {
    const { adapter, core } = newCore()
    await core.handle(ingress('/model haiku'))

    await core.handle(ingress('/effort max'))

    const [reply] = posted(adapter.instructions).slice(-1)
    expect(reply).toMatchObject({ kind: 'result', text: expect.stringContaining(HAIKU) })
    expect(reply).toMatchObject({ text: expect.stringContaining('takes none') })
  })

  it('claims only what roma read about the model, in both directions [fence:core-takes-no-effort-says-only-what-was-read]', async () => {
    const why =
      'The takes-none sentence says the effort does not apply and nothing stronger ' +
      '(ADR-0016): the build echoes every level on every model identically, so the only ' +
      'account of it is a reading of a minified binary that has already been wrong once. ' +
      'A sentence saying Claude Code ignores, strips or refuses the effort claims something ' +
      'roma never watched.'
    const { adapter, core } = newCore()
    await core.handle(ingress('/model haiku'))

    await core.handle(ingress('/effort max'))
    await core.handle(ingress('/model opus'))
    await core.handle(ingress('/model haiku'))

    const [setOnHaiku, , movedOntoHaiku] = posted(adapter.instructions).slice(-3)
    expect(setOnHaiku, why).toMatchObject({
      text:
        'This conversation runs at max from your next message. Anything already running ' +
        `finishes at the effort it started at. Effort does not apply on ${HAIKU}, which ` +
        'takes none — it applies again on a model that does.',
    })
    expect(movedOntoHaiku, why).toMatchObject({
      text: expect.stringContaining(
        `The effort this conversation is at (max) does not apply on ${HAIKU}, which ` +
          'takes none — it applies again on a model that does.',
      ),
    })
  })

  it('writes the record anyway, so it applies again on a model that takes one', async () => {
    const { claude, core, say } = newCore()
    await core.handle(ingress('/model haiku'))
    await core.handle(ingress('/effort max'))

    await core.handle(ingress('/model opus'))
    await say('hello')

    const { args } = claude.lastSpawn
    expect(args[args.indexOf('--effort') + 1]).toBe('max')
  })

  it('says so on the /model that made it inert', async () => {
    const { adapter, core } = newCore()
    await core.handle(ingress('/effort max'))

    await core.handle(ingress('/model haiku'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining('does not apply'),
    })
  })

  it('says nothing extra on a /model from a Session that chose no effort', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/model haiku'))

    expect(posted(adapter.instructions).at(-1)).not.toMatchObject({
      text: expect.stringContaining('does not apply'),
    })
  })

  it('offers no Menu to choose from, on a model that will not use one [fence:core-effort-menu-only-where-it-applies]', async () => {
    const why =
      'The Effort Menu is withheld where the Matrix says the model takes no effort ' +
      '(ADR-0023): buttons beside a sentence calling the effort inert invite the very ' +
      'thing the reply just declined.'
    const { adapter, core } = newCore()
    await core.handle(ingress('/model haiku'))

    await core.handle(ingress('/effort'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'result' })
    expect(posted(adapter.instructions).at(-1), why).not.toMatchObject({ kind: 'choice' })
  })

  it('says nothing is inert after a /model onto a model the Matrix has never been read about [fence:core-unmeasured-model-keeps-effort]', async () => {
    const why =
      'Only a Matrix answer of false says a model takes no effort (ADR-0016): null means ' +
      'never read about, and a falsy check tells somebody their chosen effort stopped ' +
      'applying on the strength of a reading roma never made.'
    const { adapter, core } = newCore({ pinnedModel: 'claude-something-nobody-measured' })
    await core.handle(ingress('/effort max'))

    await core.handle(ingress('/model default'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'result' })
    expect(posted(adapter.instructions).at(-1), why).not.toMatchObject({
      text: expect.stringContaining('takes none'),
    })
  })

  it('records the level a Task on a model nobody measured was sent at [fence:core-unmeasured-model-keeps-effort]', async () => {
    const why =
      'Only a Matrix answer of false puts EFFORT_NOT_APPLIED on the Audit Record (ADR-0016): ' +
      'for a model never read about, the record would otherwise claim the effort did not ' +
      'apply where nobody measured it.'
    const { audit, say } = newCore({ pinnedModel: 'claude-something-nobody-measured' })

    await say('hello')

    expect(recordsIn(audit).at(-1), why).toMatchObject({ effort: PINNED_EFFORT })
  })

  it('offers none on a refusal either, and still says what it refused [fence:core-effort-menu-only-where-it-applies]', async () => {
    const why =
      'The Effort Menu is withheld on a refusal too where the model takes no effort ' +
      '(ADR-0023).'
    const { adapter, core } = newCore()
    await core.handle(ingress('/model haiku'))

    await core.handle(ingress('/effort ludicrous'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('ludicrous'),
    })
  })

  it('offers the Menu on a model the Matrix has never been read about [fence:core-unmeasured-model-keeps-effort]', async () => {
    const why =
      'Only a Matrix answer of false says a model takes no effort (ADR-0016, ADR-0023): ' +
      'null means never read about, and a falsy check withholds the Menu, adds the ' +
      'takes-none sentence and records no level on the strength of a reading roma never ' +
      'made.'
    const { adapter, core } = newCore({ pinnedModel: 'claude-something-nobody-measured' })

    await core.handle(ingress('/effort'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      kind: 'choice',
      chooses: 'effort',
      refused: null,
    })
    expect(posted(adapter.instructions).at(-1), why).not.toMatchObject({
      text: expect.stringContaining('takes none'),
    })
  })

  it('records that the effort did not apply, rather than naming a level', async () => {
    const { audit, core, say } = newCore()
    await core.handle(ingress('/model haiku'))
    await core.handle(ingress('/effort max'))

    await say('hello')

    expect(recordsIn(audit).at(-1)).toMatchObject({
      model: HAIKU,
      effort: EFFORT_NOT_APPLIED,
    })
  })
})

describe('the Caveman a Conversation runs at', () => {
  const appendedTo = (spawn: { args: readonly string[] }): string | undefined => {
    const at = spawn.args.indexOf('--append-system-prompt')
    return at === -1 ? undefined : spawn.args[at + 1]
  }

  it('runs the next Task at the Caveman somebody chose, and says so from that message on', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/caveman ultra'))
    await say('hello')

    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('ultra'))
    expect(posted(adapter.instructions)[0]).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: expect.stringContaining('from your next message'),
    })
  })

  it('appends nothing where the deployment pinned none and nobody has chosen', async () => {
    const { claude, say } = newCore()

    await say('hello')

    expect(claude.lastSpawn.args).not.toContain('--append-system-prompt')
  })

  it('leaves a Task that is already running at the Caveman it started at', async () => {
    const { claude, core, say, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/caveman full'))
    feed(proc, OK)
    await task

    expect(appendedTo(claude.lastSpawn)).toBeUndefined()

    await say('and now')
    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('full'))
  })

  it('refuses a level it does not offer, by name, and moves nothing', async () => {
    const { adapter, claude, core, say } = newCore()

    await core.handle(ingress('/caveman terse'))
    await say('hello')

    expect(posted(adapter.instructions)[0]).toEqual({
      kind: 'choice',
      conversationKey: KEY,
      text: expect.stringContaining('terse'),
      chooses: 'caveman',
      options: ['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'],
      refused: 'terse',
    })
    expect(appendedTo(claude.lastSpawn)).toBeUndefined()
    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  it('refuses the two wenyan levels an operator may pin, like any other name [fence:core-wenyan-refused-as-a-typo]', async () => {
    const why =
      'wenyan-lite and wenyan-ultra are refused in exactly the words a typo is (ADR-0030): ' +
      "any sentence of their own would tell a Caller they exist and are the operator's, " +
      'which is roma advertising something no Caller can have.'
    const { adapter, claude, core } = newCore()
    await core.handle(ingress('/caveman grunt'))
    const typo = posted(adapter.instructions).at(-1)

    for (const level of ['wenyan-lite', 'wenyan-ultra']) {
      await core.handle(ingress(`/caveman ${level}`))

      expect(posted(adapter.instructions).at(-1), why).toEqual({
        ...typo,
        refused: level,
        text: (typo as { text: string }).text.replace('grunt', level),
      })

      expect(posted(adapter.instructions).at(-1)).toMatchObject({
        kind: 'choice',
        refused: level,
      })
      expect(posted(adapter.instructions).at(-1)).not.toMatchObject({
        options: expect.arrayContaining([level]),
      })
    }
    expect(claude.processes).toHaveLength(0)
  })

  it('reports the current Caveman and the Menu, without a process or a Turn', async () => {
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/caveman'))

    expect(claude.processes).toHaveLength(0)
    const [reported] = posted(adapter.instructions)
    expect(reported).toMatchObject({
      kind: 'choice',
      chooses: 'caveman',
      options: ['off', 'lite', 'full', 'ultra', 'wenyan-full', 'default'],
      refused: null,
    })
    for (const name of CAVEMAN_NAMES) {
      expect(reported).toMatchObject({ text: expect.stringContaining(name) })
    }
  })

  it('reports a Session moved to the Pinned Caveman by the name that was typed [fence:core-named-as-typed]', async () => {
    const why =
      "A Session's Caveman is named with chosenFor, never inForce (ADR-0030): a chosen " +
      'level equal to the pin is a choice, and naming it default tells the Caller an ' +
      'operator moving it takes them along.'
    const { adapter, core } = newCore({ pinnedCaveman: 'full' })

    await core.handle(ingress('/caveman full'))
    await core.handle(ingress('/caveman'))

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      text: expect.stringContaining('runs at caveman full.'),
    })
  })

  it('offers its Menu on a model that takes no effort [fence:core-caveman-menu-unconditional]', async () => {
    const why =
      'The Caveman Menu is carried unconditionally, never withheld on an #effortApplies of its ' +
      'own (ADR-0023, ADR-0030): there is no Matrix for a ruleset and no model that declines ' +
      'one, so a condition withholds an offer on the strength of nothing.'
    const { adapter, core } = newCore()
    await core.handle(ingress('/model haiku'))

    await core.handle(ingress('/caveman'))
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      kind: 'choice',
      chooses: 'caveman',
      refused: null,
    })

    await core.handle(ingress('/caveman grunt'))
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      kind: 'choice',
      chooses: 'caveman',
      refused: 'grunt',
    })
  })

  it('reports a Session nobody moved as following the Pinned Caveman', async () => {
    const { adapter, core } = newCore({ pinnedCaveman: 'lite' })

    await core.handle(ingress('/caveman'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining('default (lite)'),
    })
  })

  it('tells off, which is a level, apart from default, which is the pin', async () => {
    const { claude, core, say } = newCore({ pinnedCaveman: 'full' })

    await core.handle(ingress('/caveman off'))
    await say('hello')
    expect(appendedTo(claude.lastSpawn)).toBeUndefined()

    await core.handle(ingress('/caveman default'))
    await say('and now')
    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('full'))
  })

  it('goes back to the Pinned Caveman on /caveman default, keeping the context', async () => {
    const { claude, core, say } = newCore({ pinnedCaveman: 'lite' })
    await core.handle(ingress('/caveman ultra'))
    await say('hello')

    await core.handle(ingress('/caveman default'))
    await say('and now')

    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('lite'))
    expect(claude.lastSpawn.args).toContain(sessionIdFor(KEY))
  })

  it('goes back to the Pinned Caveman when the Conversation is cleared, deleting nothing', async () => {
    const { cavemen, claude, core, say, workRoot } = newCore({ pinnedCaveman: 'full' })
    await core.handle(ingress('/caveman off'))
    await say('hello')

    await core.handle(ingress('/clear'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('full'))
    expect(readdirSync(workRoot)).toContain(`${sessionIdFor(KEY)}.caveman`)
    expect(cavemen.inForce(sessionIdFor(KEY))).toBe('off')
  })

  it('writes the process change down as a swap, and not as an Eviction', async () => {
    const { core, poolLog, say } = newCore()
    await say('hello')

    await core.handle(ingress('/caveman lite'))
    await say('and now')

    expect(poolLog.filter(({ event }) => event === 'swap')).toEqual([
      { event: 'swap', sessionId: sessionIdFor(KEY), reason: 'caveman', from: 'off', to: 'lite' },
    ])
    expect(poolLog.filter(({ event }) => event === 'evict' || event === 'reap')).toEqual([])
  })

  it('answers while roma is running as much as it runs at once', async () => {
    const { adapter, core, start } = newCore()
    const running = [
      await start('one', KEY),
      await start('two', OTHER_KEY),
      await start('three', 'c'),
    ]

    await core.handle(ingress('/caveman'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'choice' })
    for (const { proc, task } of running) {
      feed(proc, OK)
      await task
    }
  })

  it('leaves a Task this Conversation has in flight running, and no record of its own', async () => {
    const { adapter, audit, core, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/caveman ultra'))
    feed(proc, OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
    expect(recordsIn(audit)).toHaveLength(1)
  })

  it('treats a message that merely begins with /caveman as work', async () => {
    const { claude, say } = newCore()

    await say('/caveman mode for the deploy notes')

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })
})

describe('a Chosen Caveman roma no longer offers', () => {
  const WITHHELD = 'wenyan-lite'

  function withWithheldCaveman() {
    const core = newCore()
    writeFileSync(join(core.workRoot, `${sessionIdFor(KEY)}.caveman`), WITHHELD)
    return core
  }

  it('tells the Conversation what happened and how to undo it', async () => {
    const { adapter, core } = withWithheldCaveman()

    await core.handle(ingress('hello'))

    expect(openingsIn(adapter.instructions)).toEqual([])
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'failure',
      conversationKey: KEY,
      reason: expect.stringContaining('/caveman default'),
    })
    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      reason: expect.stringContaining(WITHHELD),
    })
  })

  it('still writes the Task down, asking the record nothing more [fence:core-record-survives-a-withheld-caveman]', async () => {
    const why =
      'Writing a Task down must not ask the Chosen Caveman record anything (ADR-0030): ' +
      'that read throws for a level roma no longer offers, and asked while the Audit ' +
      'Record is written it takes the Task’s ending down with it, on the one path that ' +
      'must not fail.'
    const { adapter, audit, core } = withWithheldCaveman()

    await expect(core.handle(ingress('hello')), why).resolves.toBeUndefined()

    expect(recordsIn(audit), why).toMatchObject([{ outcome: 'failure' }])
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'failure' })
  })

  it('says the same when asked which Caveman it is at', async () => {
    const { adapter, core } = withWithheldCaveman()

    await core.handle(ingress('/caveman'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      reason: expect.stringContaining('/caveman default'),
    })
  })

  it('says the same to /config, which now reads the Caveman as well', async () => {
    const { adapter, core } = withWithheldCaveman()

    await core.handle(ingress('/config'))

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'failure',
      conversationKey: KEY,
      reason: expect.stringContaining('/caveman default'),
    })
  })

  it('is cleared by the /caveman default it recommends', async () => {
    const { adapter, claude, core, say } = withWithheldCaveman()

    await core.handle(ingress('/caveman default'))
    await say('hello')

    expect(claude.lastSpawn.args).not.toContain('--append-system-prompt')
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })
})

describe('what this Conversation is set to', () => {
  it('reports the model and the effort, without a process or a Turn', async () => {
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/config'))

    expect(claude.processes).toHaveLength(0)
    const [reported] = posted(adapter.instructions)
    expect(reported).toMatchObject({ kind: 'result', text: expect.stringContaining(PINNED_MODEL) })
    expect(reported).toMatchObject({ text: expect.stringContaining(PINNED_EFFORT) })
  })

  it('answers to /settings, which is Claude Code’s own alias', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/settings'))

    expect(posted(adapter.instructions)[0]).toMatchObject({ kind: 'result' })
  })

  it('reports what the Conversation was moved to', async () => {
    const { adapter, core } = newCore()
    await core.handle(ingress('/model opus'))
    await core.handle(ingress('/effort max'))

    await core.handle(ingress('/config'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining('opus (claude-opus-5)'),
    })
    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      text: expect.stringContaining('max'),
    })
  })

  it('refuses to set anything, and names what it does let you set [fence:core-config-sets-nothing]', async () => {
    const why =
      '/config refuses every argument, never honouring or passing it on (ADR-0017): ' +
      'every Session shares one CLAUDE_CONFIG_DIR, so a settings write persists for ' +
      'everybody, and keys like model= and workflows bypass the Model Menu and the ' +
      'ultracode lock.'
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/config model=opusplan'))

    expect(claude.processes, why).toHaveLength(0)
    expect(posted(adapter.instructions)[0], why).toEqual({
      kind: 'failure',
      conversationKey: KEY,
      reason: expect.stringContaining('/model'),
    })
    expect(posted(adapter.instructions)[0], why).toMatchObject({
      reason: expect.stringContaining('/effort'),
    })
    expect(posted(adapter.instructions)[0], why).toMatchObject({
      reason: expect.stringContaining('/caveman'),
    })
  })

  it('drives no Turn for a settings change it will not make [fence:core-config-sets-nothing]', async () => {
    const why =
      '/config with an argument is refused by roma and never handed to Claude Code ' +
      '(ADR-0017): passed on, it writes the settings file every Session in the ' +
      'deployment shares.'
    const { claude, core } = newCore()

    await core.handle(ingress('/config theme=dark'))

    expect(claude.processes, why).toHaveLength(0)
  })

  it('leaves a /config of two words as work, which ADR-0017 records rather than fixes', async () => {
    const { claude, say } = newCore()

    await say('/config foo bar')

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })
})

describe('what the deployment has spent this month', () => {
  function spent(
    audit: AuditLog,
    {
      costUsd,
      credential = 'shared-window',
      apiKeySource = apiKeySourceFor(credential),
      runtime,
      caveman,
      outputTokens,
    }: {
      costUsd: number | null
      credential?: CredentialKind
      apiKeySource?: string
      runtime?: Runtime
      caveman?: string
      outputTokens?: number | null
    },
  ) {
    audit.record({
      taskId: 'earlier',
      caller: 'users/99',
      sessionId: sessionIdFor('another'),
      outcome: 'result',
      costUsd,
      durationMs: 1_000,
      turnMs: 1_000,
      credential,
      ...(runtime === undefined ? {} : { runtime }),
      ...(caveman === undefined ? {} : { caveman }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      apiKeySource,
    })
  }

  function textIn(adapter: RecordingAdapter): string {
    const instruction = adapter.instructions.at(-1)
    if (instruction?.kind !== 'result') throw new Error('roma did not answer with a result')
    return instruction.text
  }

  it('names the month and reports both figures, without a process or a Turn [fence:core-usage-never-one-figure]', async () => {
    const why =
      '/usage prints what the subscription drew and what metered billing charged as ' +
      'separate figures, each naming its Runtime (ADR-0027): a sum prints quota as ' +
      "money, or adds two subscriptions' quotas."
    const { adapter, audit, claude, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    spent(audit, { costUsd: 1.34, credential: 'overflow' })

    await core.handle(ingress('/usage'))

    expect(claude.processes, why).toHaveLength(0)
    expect(posted(adapter.instructions), why).toEqual([
      {
        kind: 'result',
        conversationKey: KEY,
        text:
          'July 2026 (UTC).\n' +
          'Claude Code’s subscription drew $0.21 worth of work. Nobody is billed for that.\n' +
          'Metered billing charged $1.34 for Tasks on Claude Code.',
      },
    ])
  })

  it('reports the two figures once per Runtime, which is one line each today [fence:core-usage-never-one-figure]', async () => {
    const why =
      'Every /usage line names its Runtime, though there is one today (ADR-0025, ' +
      'ADR-0027): a line worded for the deployment goes on reading right at the moment ' +
      'a second Runtime makes it wrong.'
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    spent(audit, { costUsd: 1.34, credential: 'overflow' })

    await core.handle(ingress('/usage'))

    const [named, ...figures] = textIn(adapter).split('\n')
    expect(named, why).toBe('July 2026 (UTC).')
    expect(figures, why).toHaveLength(RUNTIMES.length * 2)
    for (const runtime of RUNTIMES) {
      expect(
        figures.filter((line) => line.includes(RUNTIME_NAMES[runtime])),
        why,
      ).toHaveLength(2)
    }
  })

  it('says nothing more for a month whose records carry a Caveman and what it produced', async () => {
    const plain = newCore()
    spent(plain.audit, { costUsd: 0.21 })
    const measured = newCore({ pinnedCaveman: 'ultra' })
    spent(measured.audit, { costUsd: 0.21, caveman: 'ultra', outputTokens: 1978 })

    await plain.core.handle(ingress('/usage'))
    await measured.core.handle(ingress('/usage'))

    expect(textIn(measured.adapter)).toBe(textIn(plain.adapter))
    expect(textIn(measured.adapter)).not.toMatch(/token/i)
  })

  it('answers /cost and /stats with the very same thing', async () => {
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })

    const said: string[] = []
    for (const spelling of ['/usage', '/cost', '/stats']) {
      await core.handle(ingress(spelling))
      said.push(textIn(adapter))
    }

    const [usage, cost, stats] = said
    expect(cost).toBe(usage)
    expect(stats).toBe(usage)
    expect(usage).toContain('$0.21')
  })

  it('answers the same wherever it was sent [fence:core-usage-is-the-deployments]', async () => {
    const why =
      '/usage answers about the deployment, never the Conversation that asked ' +
      '(ADR-0027): narrowed to a thread it answers a different question rather than a ' +
      'narrower one.'
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })

    await core.handle(ingress('/usage', KEY))
    const mine = textIn(adapter)
    await core.handle(ingress('/usage', OTHER_KEY))

    expect(textIn(adapter), why).toBe(mine)
    expect(
      posted(adapter.instructions).map(({ conversationKey }) => conversationKey),
      why,
    ).toEqual([KEY, OTHER_KEY])
  })

  it('gives the figure as a floor where the month holds a Turn nothing priced', async () => {
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    spent(audit, { costUsd: null })
    spent(audit, { costUsd: null })
    spent(audit, { costUsd: null })

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toBe(
      'July 2026 (UTC).\n' +
        'Claude Code’s subscription drew at least $0.21 worth of work. Nobody is billed for that.\n' +
        'Metered billing charged $0.00 for Tasks on Claude Code.',
    )
    expect(textIn(adapter)).not.toContain('3')
  })

  it('gives it as exact where nothing in the month went unpriced', async () => {
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toContain('Claude Code’s subscription drew $0.21 worth of work.')
    expect(textIn(adapter)).not.toContain('at least')
  })

  it('counts a record written before the field beside one written after it', async () => {
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    spent(audit, { costUsd: 0.09, runtime: 'claude-code' })

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toContain('Claude Code’s subscription drew $0.30 worth of work.')
  })

  it('vouches for nothing in a month holding a record it cannot read back', async () => {
    const { adapter, audit, auditRoot, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    appendFileSync(join(auditRoot, `${MONTH}.jsonl`), '{"at":"2026-07-28T19:40:00.000Z","cos')

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toContain('roma cannot vouch for July 2026 (UTC)')
    expect(textIn(adapter)).not.toContain('$')
  })

  it('vouches for nothing where a record names a Runtime it cannot name', async () => {
    const { adapter, audit, auditRoot, core } = newCore()
    spent(audit, { costUsd: 0.21 })
    appendFileSync(
      join(auditRoot, `${MONTH}.jsonl`),
      `${JSON.stringify({
        at: new Date(NOW).toISOString(),
        taskId: 'elsewhere',
        caller: 'users/99',
        callerName: null,
        sessionId: sessionIdFor('another'),
        outcome: 'result',
        costUsd: 9.99,
        durationMs: 1_000,
        turnMs: 1_000,
        credential: 'shared-window',
        runtime: 'codex',
        apiKeySource: 'none',
      })}\n`,
    )

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toContain('roma cannot vouch for July 2026 (UTC)')
    expect(textIn(adapter)).not.toContain('9.99')
  })

  it('vouches for nothing where the credential roma ran on is not the one that paid', async () => {
    const { adapter, audit, core } = newCore()
    spent(audit, { costUsd: 0.21, apiKeySource: 'ANTHROPIC_API_KEY' })

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toContain('roma cannot vouch for July 2026 (UTC)')
    expect(textIn(adapter)).not.toContain('$')
  })

  it('reads a month nothing has run in as a month with nothing in it', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/usage'))

    expect(textIn(adapter)).toBe('July 2026 (UTC): nothing has run.')
  })

  it('leaves a Task this Conversation has in flight running', async () => {
    const { adapter, core, start } = newCore()
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/usage'))

    expect(proc.sent.filter((frame) => frame['type'] === 'control_request')).toEqual([])
    expect(proc.signals).toEqual([])

    feed(proc, OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('leaves no Audit Record of its own', async () => {
    const { audit, core, say } = newCore()
    await say('hello')

    await core.handle(ingress('/usage'))
    await core.handle(ingress('/cost'))
    await core.handle(ingress('/stats'))

    expect(recordsIn(audit)).toHaveLength(1)
  })

  it('sends the Session’s process nothing at all', async () => {
    const { claude, core, say } = newCore()
    await say('hello')

    for (const spelling of ['/usage', '/cost', '/stats']) {
      await core.handle(ingress(spelling))
    }

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  it('leaves a /usage with an argument as work, which ADR-0027 records rather than fixes', async () => {
    const { claude, say } = newCore()

    await say('/usage july')

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '<from>Ada (users/17)</from>\n\n/usage july' }] },
    })
  })
})

describe('the first thing roma says in a Session', () => {
  it('says exactly what /config says, out of the same reading [fence:core-opening-says-what-config-says]', async () => {
    const why =
      'The Opening and /config are one sentence built from one reading (ADR-0024): a ' +
      'second copy that reads the records again drifts from the first, and nobody ' +
      'compares the top of a thread with /config a week later.'
    const { adapter, core, say } = newCore()

    await say('hello')
    await core.handle(ingress('/config'))

    const said = posted(adapter.instructions)
    expect(said.at(0), why).toEqual(said.at(-1))
    expect(said.at(0), why).toMatchObject({
      kind: 'result',
      conversationKey: KEY,
      text: expect.stringContaining(PINNED_MODEL),
    })
    expect(said.at(0), why).toMatchObject({ text: expect.stringContaining(PINNED_EFFORT) })
  })

  it('says exactly what /config says where this Session runs at a Caveman', async () => {
    const { adapter, core, say } = newCore({ pinnedCaveman: 'full' })

    await say('hello')
    await core.handle(ingress('/config'))

    const said = posted(adapter.instructions)
    expect(said.at(0)).toEqual(said.at(-1))
    expect(said.at(0)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: SETTINGS_AT_A_PINNED_CAVEMAN,
    })
  })

  it('is the Opening it has always been where this Session is off [fence:core-opening-says-what-config-says]', async () => {
    const why =
      'The Caveman fact is in the Opening only where the level in force is not off ' +
      '(ADR-0024, ADR-0030): made unconditional, or decided with chosenFor, every first ' +
      'message on a deployment that never turned caveman on says at caveman default ' +
      '(off).'
    const { adapter, say } = newCore()

    await say('hello')

    expect(posted(openingsIn(adapter.instructions)), why).toEqual([
      { kind: 'result', conversationKey: KEY, text: SETTINGS_WITHOUT_A_CAVEMAN },
    ])
  })

  it('opens on the Pinned Caveman again when a Session that chose off is cleared', async () => {
    const { adapter, core, say } = newCore({ pinnedCaveman: 'full' })
    await core.handle(ingress('/caveman off'))
    await say('hello')

    await core.handle(ingress('/clear'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    expect(posted(openingsIn(adapter.instructions))).toEqual([
      { kind: 'result', conversationKey: KEY, text: SETTINGS_WITHOUT_A_CAVEMAN },
      { kind: 'result', conversationKey: KEY, text: SETTINGS_AT_A_PINNED_CAVEMAN },
    ])
  })

  it('is not shortened by the Caveman it is announcing', async () => {
    const { adapter, claude, say } = newCore({ pinnedCaveman: 'ultra' })

    await say('hello')

    expect(claude.lastSpawn.args).toContain(cavemanRuleset('ultra'))
    expect(posted(openingsIn(adapter.instructions))).toEqual([
      {
        kind: 'result',
        conversationKey: KEY,
        text:
          `This conversation is on default (${PINNED_MODEL}), at default (${PINNED_EFFORT}), ` +
          `at caveman default (ultra). Change any with “/model”, “/effort” or “/caveman”.`,
      },
    ])
  })

  it('goes out ahead of the acknowledgement [fence:core-opening-travels-with-the-message]', async () => {
    const why =
      'The Opening reaches the Channel before anything the Task produces (ADR-0024): ' +
      'every instruction waits on it, so an Opening after the acknowledgement would be ' +
      'a receipt.'
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')

    expect(
      adapter.instructions.map(({ kind }) => kind),
      why,
    ).toEqual(['result', 'progress'])

    feed(proc, OK)
    await task
  })

  it('says it once, however long the Conversation goes on', async () => {
    const { adapter, say } = newCore()

    await say('hello')
    await say('and another')
    await say('and another')

    expect(openingsIn(adapter.instructions)).toHaveLength(1)
  })

  it('opens the Session a /clear gave the Conversation, on the pinned values', async () => {
    const { adapter, core, models, say } = newCore()
    models.choose(sessionIdFor(KEY), 'claude-opus-5')
    await say('hello')

    await core.handle(ingress('/clear'))
    await say('and now', { session: sessionIdFor(KEY, 1) })

    const [chosen, cleared] = openingsIn(adapter.instructions)
    expect(chosen).toMatchObject({ text: expect.stringContaining('claude-opus-5') })
    expect(cleared).toMatchObject({ text: expect.stringContaining(PINNED_MODEL) })
  })

  it('opens nothing for a Command', async () => {
    for (const spelling of ['/stop', '/clear', '/config', '/usage', '/model opus', '/effort max']) {
      const { adapter, core } = newCore()

      await core.handle(ingress(spelling))

      expect(adapter.instructions, spelling).toHaveLength(1)
    }
  })

  it('does not open a Session another roma already opened', async () => {
    const first = newCore()
    await first.say('hello')
    const second = newCore({ workRoot: first.workRoot })

    await second.say('and now')

    expect(openingsIn(second.adapter.instructions)).toEqual([])
  })

  it('does not open a Session whose Working Directory was reclaimed', async () => {
    const { adapter, pool, say, workRoot } = newCore()
    await say('hello')
    await pool.evict(sessionIdFor(KEY))
    const cwd = join(workRoot, sessionIdFor(KEY))
    const aged = (Date.now() - 8 * 24 * 60 * 60_000) / 1000
    utimesSync(cwd, aged, aged)
    expect(pool.reclaimIdleWorkDirs()).toEqual([sessionIdFor(KEY)])

    await say('and now')

    expect(openingsIn(adapter.instructions)).toHaveLength(1)
  })

  it('opens once when two messages arrive together [fence:core-opening-travels-with-the-message]', async () => {
    const why =
      'One Session, one Opening (ADR-0024): the Opening is registered before it is ' +
      'awaited, so a second message that arrives while it is going out waits for it ' +
      'rather than opening again.'
    const { adapter, core, procFor } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()
    const proc = procFor(KEY)
    feed(proc, OK)
    await first
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await second

    expect(openingsIn(adapter.instructions), why).toHaveLength(1)
  })

  const NEVER_OUTWARDS =
    'An Opening may never fail outwards (ADR-0024): everything the message goes on to ' +
    'produce waits on its promise, so a rejection rejects the Task’s own delivery, hands ' +
    'the Delivery back to the Transport, and redelivers a Turn that has already been paid ' +
    'for. A Channel refusing it, or the record of it failing to write, is absorbed.'

  it('runs the Task anyway when the Channel refuses the Opening [fence:core-opening-never-fails-outwards]', async () => {
    const { core, delivered } = refusingTheOpening(newCore())

    await core.say('hello')

    expect(posted(delivered), NEVER_OUTWARDS).toEqual([
      { kind: 'progress', conversationKey: KEY, progress: { phase: 'working' } },
      { kind: 'result', conversationKey: KEY, text: 'ok' },
    ])
  })

  it('runs the Task anyway when the Opening was said and its record could not be written [fence:core-opening-never-fails-outwards]', async () => {
    const shared = newCore()
    const opened = shared.work.openedRecord(sessionIdFor(KEY))
    const write = shared.work.writeRecord.bind(shared.work)
    vi.spyOn(shared.work, 'writeRecord').mockImplementation((path, contents) => {
      if (path === opened) throw new Error('EACCES: the Work Root cannot be written to')
      write(path, contents)
    })

    await expect(shared.say('hello'), NEVER_OUTWARDS).resolves.toBeUndefined()

    expect(posted(shared.adapter.instructions).at(-1), NEVER_OUTWARDS).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('opens on the next message when the Channel refused the last one', async () => {
    const { core, delivered } = refusingTheOpening(newCore())

    await core.say('hello')
    await core.say('and now', { events: THREE_TURNS.turn(3) })

    expect(openingsIn(delivered)).toHaveLength(1)
  })

  it('leaves no Audit Record of its own', async () => {
    const { audit, say } = newCore()

    await say('hello')

    expect(recordsIn(audit)).toHaveLength(1)
  })
})

describe('a Chosen Model roma no longer offers', () => {
  const WITHDRAWN = 'claude-opus-4-5'

  function withWithdrawnModel() {
    const core = newCore()
    writeFileSync(join(core.workRoot, `${sessionIdFor(KEY)}.model`), WITHDRAWN)
    return core
  }

  it('tells the Conversation what happened and how to undo it', async () => {
    const { adapter, core } = withWithdrawnModel()

    await core.handle(ingress('hello'))

    expect(posted(adapter.instructions)).toEqual([
      {
        kind: 'failure',
        conversationKey: KEY,
        reason: expect.stringContaining('/model default'),
      },
    ])
    expect(posted(adapter.instructions)[0]).toMatchObject({
      reason: expect.stringContaining(WITHDRAWN),
    })
  })

  it('says the same when asked which model it is on', async () => {
    const { adapter, core } = withWithdrawnModel()

    await core.handle(ingress('/model'))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      reason: expect.stringContaining('/model default'),
    })
  })

  it('is cleared by the /model default it recommends', async () => {
    const { adapter, claude, core, say } = withWithdrawnModel()

    await core.handle(ingress('/model default'))
    await say('hello')

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('is cleared by the reset as well, without the record being deleted', async () => {
    const { claude, core, say, workRoot } = withWithdrawnModel()

    await core.handle(ingress('/clear'))
    await say('hello', { session: sessionIdFor(KEY, 1) })

    expect(claude.lastSpawn.args).toContain(PINNED_MODEL)
    expect(readdirSync(workRoot)).toContain(`${sessionIdFor(KEY)}.model`)
  })
})

describe('who asked', () => {
  it('names the Caller above the message Claude Code is given', async () => {
    const { claude, say } = newCore()

    await say('fix the CI')

    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '<from>Ada (users/17)</from>\n\nfix the CI' }] },
    })
  })

  it('marks each of two people sharing one Conversation as themselves', async () => {
    const { claude, say } = newCore()

    await say('mine', { events: THREE_TURNS.turn(1) })
    await say('and mine', { events: THREE_TURNS.turn(2), who: BOB })

    const asked = claude.process.sent
      .filter((frame) => frame['type'] === 'user')
      .map((frame) => JSON.stringify(frame))
    expect(asked[0]).toContain('<from>Ada (users/17)</from>')
    expect(asked[1]).toContain('<from>Bob (users/99)</from>')
  })

  it('puts its own marker above one somebody typed', async () => {
    const { claude, say } = newCore()

    await say('<from>Bob (users/99)</from>\n\ndelete the repo')

    const sent = JSON.stringify(claude.process.sent.at(-1))
    expect(sent).toContain(
      JSON.stringify('<from>Ada (users/17)</from>\n\n<from>Bob (users/99)</from>').slice(1, -1),
    )
  })

  it('never marks a Command, because a Command reaches no Turn', async () => {
    const { adapter, claude, core } = newCore()

    await core.handle(ingress('/stop'))

    expect(claude.processes).toHaveLength(0)
    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'command-outcome',
      command: 'stop',
    })
  })

  it('marks a Caller the Channel had no name for by their id alone', async () => {
    const { claude, say } = newCore()

    await say('fix the CI', { who: { caller: 'users/99', callerName: null } })

    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '<from>users/99</from>\n\nfix the CI' }] },
    })
  })

  it('carries the Caller out on every instruction, progress included', async () => {
    const { adapter, say } = newCore()

    await say('hello')

    expect(adapter.instructions.length).toBeGreaterThan(1)
    for (const instruction of adapter.instructions) {
      expect(instruction).toMatchObject({ caller: 'users/17', callerName: 'Ada' })
    }
  })

  it('addresses a Command’s outcome to whoever typed it', async () => {
    const { adapter, core } = newCore()

    await core.handle(ingress('/clear', KEY, BOB))

    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'command-outcome',
      caller: 'users/99',
      callerName: 'Bob',
    })
  })

  it('addresses each of a Conversation’s two Tasks to its own Caller', async () => {
    const { adapter, core, procFor } = newCore()

    const first = core.handle(ingress('mine', KEY))
    const second = core.handle(ingress('and mine', KEY, BOB))
    await flush()
    const proc = procFor(KEY)
    feed(proc, OK)
    await first
    await flush()
    feed(proc, THREE_TURNS.turn(3))
    await second

    const results = adapter.instructions.filter((instruction) => instruction.kind === 'result')
    expect(results.map((instruction) => instruction.caller)).toEqual([
      'users/17',
      'users/17',
      'users/99',
    ])
  })
})

describe('the record every Task leaves behind', () => {
  const INTERRUPTED = recordedStream('interrupted-turn')

  it('files every Task under the only Runtime there is, and stops compiling when there are two [fence:core-runtime-is-the-only-one]', async () => {
    const why =
      'The Core writes one Runtime onto every Audit Record because Runtime has one member ' +
      '(ADR-0025). The day it has two, a Session has a Runtime of its own and the record must ' +
      "read it from there (ADR-0027): a Codex Task filed as Claude Code's is filed against " +
      'the wrong Shared Window, and telling two windows apart is the only thing the field is for.'
    const { audit, say } = newCore()

    await say('hello')

    const onlyOneRuntime: [Runtime] extends ['claude-code'] ? true : never = true
    expect(onlyOneRuntime, why).toBe(true)
    expect(
      recordsIn(audit).map(({ runtime }) => runtime),
      why,
    ).toEqual(['claude-code'])
  })

  it('says who asked, which Session ran it, how long it took and what it cost', async () => {
    const { audit, say } = newCore()

    await say('hello')

    expect(recordsIn(audit)).toEqual([
      {
        at: new Date(NOW).toISOString(),
        taskId: expect.any(String),
        caller: 'users/17',
        callerName: 'Ada',
        sessionId: sessionIdFor(KEY),
        outcome: 'result',
        costUsd: expect.closeTo(0.0103129, 7),
        durationMs: 0,
        turnMs: 0,
        credential: 'shared-window',
        runtime: 'claude-code',
        model: PINNED_MODEL,
        effort: PINNED_EFFORT,
        caveman: CAVEMAN_NOT_PINNED,
        outputTokens: 17,
        cloudReach: false,
        documentReach: false,
        apiKeySource: 'none',
      },
    ])
  })

  it('records five Tasks of one Session at five separate costs', async () => {
    const { audit, say } = newCore()

    for (const total of [0.01, 0.02, 0.035, 0.05, 0.06]) {
      await say('hello', { events: withTotalCostUsd(OK, total) })
    }

    const costs = recordsIn(audit).map((record) => Number(record.costUsd?.toFixed(6)))
    expect(costs).toEqual([0.01, 0.01, 0.015, 0.015, 0.01])
    expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(0.06, 6)
  })

  const cumulativeOutputIn = (events: readonly ClaudeEvent[]): number => {
    const usage = events.at(-1)?.['modelUsage']
    if (typeof usage !== 'object' || usage === null) {
      throw new Error('that capture does not end on a measured result')
    }
    return Object.values(usage as Record<string, { outputTokens?: number }>).reduce(
      (total, model) => total + (model.outputTokens ?? 0),
      0,
    )
  }

  it('records three Tasks of one Session at what each of them produced', async () => {
    const { audit, say } = newCore()

    for (const nth of [1, 2, 3]) {
      await say('hello', { events: THREE_TURNS.turn(nth) })
    }

    expect(recordsIn(audit).map((record) => record.outputTokens)).toEqual([17, 0, 0])
    expect([1, 2, 3].map((nth) => cumulativeOutputIn(THREE_TURNS.turn(nth)))).toEqual([17, 17, 3])
  })

  it('tells a Task that produced nothing from one nothing ever measured', async () => {
    const { audit, claude, core, procFor } = newCore()

    const died = core.handle(ingress('hello'))
    await flush()
    claude.process.emitExit({ code: 1, signal: null })
    await died

    const busy = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const queued = core.handle(ingress('a long job', 'four'))
    await flush()
    await core.handle(ingress('/stop', 'four'))
    for (const key of ['one', 'two', 'three']) {
      feed(procFor(key), OK)
    }
    await Promise.all(busy)
    await queued

    const records = recordsIn(audit)
    expect(records.at(0)).toMatchObject({ outcome: 'failure', outputTokens: null })
    expect(records.find((record) => record.sessionId === sessionIdFor('four'))).toMatchObject({
      outcome: 'stopped',
      outputTokens: 0,
    })
  })

  it('records the Caveman the Task ran at, not the one chosen while it ran [fence:core-ledger-names-what-ran]', async () => {
    const why =
      'The Audit Record names the Caveman the process was rendered at, read off the ' +
      'process (ADR-0030): read from the Chosen Record at record time, a /caveman that ' +
      'landed mid-Turn is recorded as what the Task ran at.'
    const { audit, core, say, start } = newCore({ pinnedCaveman: 'lite' })
    const { task, proc } = await start('a long job')

    await core.handle(ingress('/caveman ultra'))
    feed(proc, OK)
    await task
    await say('and now')

    expect(
      recordsIn(audit).map((record) => record.caveman),
      why,
    ).toEqual(['lite', 'ultra'])
  })

  it('says a deployment named no Caveman rather than naming a level nobody chose [fence:core-caveman-not-pinned-on-record]', async () => {
    const why =
      'A deployment that named no Caveman is recorded as CAVEMAN_NOT_PINNED, never as ' +
      'off (ADR-0030): the two run identically, and the Audit Record is the one place ' +
      'pinning off and pinning nothing may not be one string.'
    const { audit: named, say: sayPinned } = newCore({ pinnedCaveman: CAVEMAN_OFF })
    const { audit: unnamed, say } = newCore()

    await sayPinned('hello')
    await say('hello')

    expect(
      recordsIn(named).map((record) => record.caveman),
      why,
    ).toEqual([CAVEMAN_OFF])
    expect(
      recordsIn(unnamed).map((record) => record.caveman),
      why,
    ).toEqual([CAVEMAN_NOT_PINNED])
    expect(CAVEMAN_NAMES, why).not.toContain(CAVEMAN_NOT_PINNED)
  })

  it('separates how long the person waited from how long the Turn took', async () => {
    const { audit, core, procFor } = newCore()

    const first = core.handle(ingress('first'))
    const second = core.handle(ingress('second'))
    await flush()
    const proc = procFor(KEY)
    await vi.advanceTimersByTimeAsync(3_000)
    feed(proc, OK)
    await first
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    feed(proc, THREE_TURNS.turn(3))
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

  it('records a Task that failed, at what the failed Turn was priced', async () => {
    const { audit, say } = newCore()

    await say('hello', { events: FAILED_OUTRIGHT })

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'failure', costUsd: 0 }])
  })

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

  it('records a Task that was stopped before it ever reached Claude Code', async () => {
    const { audit, core, procFor } = newCore()
    const busy = ['one', 'two', 'three'].map((key) => core.handle(ingress('hello', key)))
    await flush()
    const waiting = core.handle(ingress('a long job', 'four'))
    await flush()

    await core.handle(ingress('/stop', 'four'))
    for (const key of ['one', 'two', 'three']) {
      feed(procFor(key), OK)
    }
    await Promise.all(busy)
    await waiting

    expect(
      recordsIn(audit).find((record) => record.sessionId === sessionIdFor('four')),
    ).toMatchObject({ outcome: 'stopped', costUsd: 0, turnMs: null })
  })

  it('records a Task abandoned mid-retry-storm as unpriced', async () => {
    const { audit, start } = newCore({ retryBudget: { maxApiRetries: 3, windowMs: 60_000 } })

    const { task, proc } = await start('hello')
    feed(proc, RETRIES.slice(0, 3))
    await task

    expect(recordsIn(audit)).toMatchObject([{ outcome: 'failure', costUsd: null, turnMs: null }])
  })

  it('records nothing for a Command', async () => {
    const { audit, core, say } = newCore()

    await say('hello')
    await core.handle(ingress('/stop'))
    await core.handle(ingress('/clear'))

    expect(recordsIn(audit)).toHaveLength(1)
  })

  it('records a Task whose outcome the Channel never took', async () => {
    const shared = newCore()
    const { audit, procFor } = shared
    const core = coreOver(
      shared,
      channelThat(() => {
        throw new Error('the Channel is down')
      }),
    )

    const task = core.handle(ingress('hello'))
    task.catch(() => {})
    await flush()
    feed(procFor(KEY), OK)
    await expect(task).rejects.toThrow('the Channel is down')

    expect(recordsIn(audit)).toMatchObject([
      { outcome: 'result', costUsd: expect.closeTo(0.0103129, 7) },
    ])
  })

  it('records what roma ran the Task on and what Claude Code says paid for it', async () => {
    const { audit, say } = newCore()

    await say('hello', { events: withApiKeySource(OK, 'ANTHROPIC_API_KEY') })

    expect(recordsIn(audit)).toMatchObject([
      { credential: 'shared-window', apiKeySource: 'ANTHROPIC_API_KEY' },
    ])
    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 1, mismatched: 1 })
  })
})

describe('a Compaction inside a Task', () => {
  it('says on the Audit Record that this Task compacted, and who asked', async () => {
    const { audit, say } = newCore()

    await say('OK', { events: COMPACTED })

    expect(recordsIn(audit)).toMatchObject([
      {
        compaction: { trigger: 'auto', preTokens: 61486, postTokens: 1375 },
      },
    ])
  })

  it('leaves the field off a Task that did not compact', async () => {
    const { audit, say } = newCore()

    await say('hello')

    expect(recordsIn(audit).at(0)).not.toHaveProperty('compaction')
  })

  it('tells nobody about one that worked', async () => {
    const { adapter, log, say } = newCore()

    await say('OK', { events: COMPACTED })

    expect(log).toEqual([])
    expect(posted(adapter.instructions).map(({ kind }) => kind)).toEqual([
      'result',
      'progress',
      'result',
    ])
  })
})

describe('a Compaction that failed', () => {
  it('says nothing at all about the benign one both captures hold', async () => {
    const { adapter, log, say } = newCore()

    await say('OK', { events: COMPACTION_FAILED })

    expect(log).toEqual([])
    expect(posted(adapter.instructions).map(({ kind }) => kind)).toEqual([
      'result',
      'progress',
      'result',
    ])
  })

  it('tells the Caller their thread is full when the context cannot be reduced', async () => {
    const { adapter, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'exhausted') })

    expect(posted(adapter.instructions)).toContainEqual({
      kind: 'context-full',
      conversationKey: KEY,
    })
  })

  it('leaves the Task its own ending', async () => {
    const { adapter, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'exhausted') })

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result' })
  })

  it('writes the serious one down for the operator', async () => {
    const { log, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'exhausted') })

    expect(log).toEqual([
      {
        event: 'compaction-failed',
        taskId: expect.any(String),
        sessionId: sessionIdFor(KEY),
        code: 'exhausted',
        severity: 'unreducible',
      },
    ])
  })

  it('answers media it cannot strip the same way', async () => {
    const { adapter, log, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'media_unstrippable') })

    expect(log).toMatchObject([{ code: 'media_unstrippable', severity: 'unreducible' }])
    expect(posted(adapter.instructions)).toContainEqual({
      kind: 'context-full',
      conversationKey: KEY,
    })
  })

  it('tells the Caller once however many times the Compaction fails [fence:core-context-full-once-per-task]', async () => {
    const why =
      'A Task tells its Caller once that the Session cannot be reduced, not once per ' +
      'failed Compaction (ADR-0010, ADR-0019): every Attempt of an unreducible Session ' +
      'fails the same way, and a message per failure floods the Conversation.'
    const { adapter, log, say } = newCore()
    const failing = withCompactionError(COMPACTION_FAILED, 'exhausted')

    await say('OK', {
      events: failing.flatMap((event) =>
        event['compact_result'] === 'failed' ? [event, event] : [event],
      ),
    })

    expect(
      posted(adapter.instructions).filter(({ kind }) => kind === 'context-full'),
      why,
    ).toHaveLength(1)
    expect(log, why).toHaveLength(2)
  })

  it('shows an unknown code to the operator and to nobody else', async () => {
    const { adapter, log, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'something_new') })

    expect(log).toMatchObject([{ code: 'something_new', severity: 'unexplained' }])
    expect(posted(adapter.instructions).map(({ kind }) => kind)).toEqual([
      'result',
      'progress',
      'result',
    ])
  })
})

describe('when the Shared Window is spent', () => {
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

  it('reports the real failure when the window was only close to spent', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, NEARLY_SPENT)
    await task

    expect(adapter.instructions.filter(({ kind }) => kind === 'blocked')).toEqual([])
    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'failure' })
  })

  it('does not run the Task again when the window was only close to spent', async () => {
    const { claude, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, NEARLY_SPENT)
    await task

    expect(claude.process.sent.filter((frame) => frame['type'] === 'user')).toHaveLength(1)
  })

  it('keeps the Task without holding a slot while it waits', async () => {
    const { queue, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()

    expect(queue.running).toBe(0)
    expect(queue.waiting).toBe(0)

    leftParked(task)
  })

  it('runs the Task again when the window resets, and answers it', async () => {
    const { adapter, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('leaves one Audit Record for a Task that was blocked and then ran', async () => {
    const { audit, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(recordsIn(audit)).toHaveLength(1)
    expect(recordsIn(audit)[0]).toMatchObject({ outcome: 'result', credential: 'shared-window' })
  })

  it('lets a parked Task be stopped rather than waiting out the window [fence:core-stop-wakes-a-parked-task]', async () => {
    const why =
      '/stop wakes a parked Task (ADR-0002): it has no Turn to interrupt, and left ' +
      'asleep it waits out the Shared Window for hours after somebody said to stop.'
    const { adapter, core, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await core.handle(ingress('/stop'))
    await task

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'stopped',
      conversationKey: KEY,
    })
  })

  it('still runs a Task whose Channel would not take the notice that it was blocked [fence:core-tell-absorbs-failures]', async () => {
    const why =
      'A notice about a Task that is still going is absorbed when the Channel refuses it ' +
      '(ADR-0002, ADR-0010): propagated, a Channel hiccup on the blocked notice throws away ' +
      'a Task that would still have answered.'
    const shared = newCore()
    const delivered: OutboundInstruction[] = []
    const core = coreOver(
      shared,
      channelThat((instruction) => {
        if (instruction.kind === 'blocked') throw new Error('the Channel is down')
        delivered.push(instruction)
      }),
    )

    const task = core.handle(ingress('hello'))
    await flush()
    feed(shared.procFor(KEY), BLOCKED)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(shared.procFor(KEY), OK)
    await task

    expect(posted(delivered).at(-1), why).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'ok',
    })
  })

  it('fails the Task rather than parking it against a reset it was not told [fence:core-park-only-on-a-known-reset]', async () => {
    const why =
      'A Task parks only against a reset time the event gave (ADR-0002): parked without ' +
      'one it waits for ever, and nothing else in roma comes to look at it.'
    const { adapter, start } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, [quotaEvent({ status: 'rejected', resetsAt: null }), ...FAILED_OUTRIGHT])
    await task

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'failure' })
  })
})

describe('offering Overflow, and taking it', () => {
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

  it('reruns the blocked Task on the metered credential', async () => {
    const { adapter, audit, claude, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    expect(await core.takeOverflow(taskIdOf(adapter))).toBe(true)
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })
    expect(claude.lastSpawn.args).toContain('--resume')
    expect(recordsIn(audit)).toMatchObject([{ credential: 'overflow', outcome: 'result' }])
  })

  it('shows what the Overflow Turn spent, in the reply', async () => {
    const { adapter, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'result',
      overflowCostUsd: expect.closeTo(0.0103129, 7),
    })
  })

  it('leaves the next Task in the Conversation on the Shared Window', async () => {
    const { adapter, claude, core, start, say, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task
    await say('and another', { events: THREE_TURNS.turn(3) })

    expect(claude.lastSpawn.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
  })

  it('says there was no offer to take when the Task is no longer waiting', async () => {
    const { core, say } = newCore()

    await say('hello')

    expect(await core.takeOverflow('a-task-that-is-over')).toBe(false)
  })
})

describe('a Task that is blocked more than once', () => {
  async function letTheWindowReset(waitMs = UNTIL_RESET) {
    await vi.advanceTimersByTimeAsync(waitMs)
    await flush()
  }

  it('does not park again on a failure the window had nothing to do with', async () => {
    const { adapter, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await letTheWindowReset()
    feed(procFor(KEY), FAILED_OUTRIGHT)
    await task

    expect(adapter.instructions.filter(({ kind }) => kind === 'blocked')).toHaveLength(1)
    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('401'),
    })
  })

  it('answers the Task rather than holding it through a third window [fence:core-park-only-on-a-known-reset]', async () => {
    const why =
      'A Task parks at most twice (ADR-0002): a Task that never ends is one nobody can ' +
      'be told about, and answered and re-sendable beats held indefinitely.'
    const { adapter, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED)
    await flush()
    await letTheWindowReset()
    feed(procFor(KEY), BLOCKED)
    await flush()
    await letTheWindowReset(60_000)
    feed(procFor(KEY), BLOCKED)
    await task

    expect(
      adapter.instructions.filter(({ kind }) => kind === 'blocked'),
      why,
    ).toHaveLength(2)
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'failure' })
  })
})

describe('what Overflow is taken for', () => {
  const BLOCKED_HAVING_SPENT = withTotalCostUsd(BLOCKED_WITH_OVERAGE, 0.02)

  it('goes back to the Shared Window for the next attempt of the same Task [fence:core-overflow-is-for-one-attempt]', async () => {
    const why =
      'Overflow pays for one Attempt, not the Task: after every Attempt the Core moves the ' +
      'Task back to the credential it was started with (ADR-0002). Left on the metered ' +
      'credential, a Task that took Overflow and was blocked again would go on spending ' +
      'metered money with nobody asked and no cap consulted.'
    const { adapter, claude, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), BLOCKED_WITH_OVERAGE)
    await flush()
    expect(claude.lastSpawn.env).toMatchObject({ ANTHROPIC_API_KEY: 'metered-key' })

    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(claude.lastSpawn.env, why).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' })
  })

  it('files the Task under the credential that answered, not the one that only tried', async () => {
    const { adapter, audit, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), BLOCKED_WITH_OVERAGE)
    await flush()
    await vi.advanceTimersByTimeAsync(UNTIL_RESET)
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(recordsIn(audit).map((record) => record.credential)).toEqual(['shared-window'])
  })

  it('keeps the record of a Compaction on an Attempt nothing priced', async () => {
    const { adapter, audit, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, [...ofKind(COMPACTED, 'system/compact_boundary'), ...BLOCKED_WITH_OVERAGE])
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(recordsIn(audit)).toMatchObject([
      { credential: 'overflow' },
      { credential: 'shared-window', compaction: { trigger: 'auto' } },
    ])
    expect(recordsIn(audit).at(0)).not.toHaveProperty('compaction')
  })

  it('asks each Reach once, so both of a Task’s records carry the same answer [fence:core-reach-asked-once]', async () => {
    const why =
      'Each Reach is asked once per Task, outside the loop that writes its records ' +
      '(ADR-0022): the answer is read-and-forget, so asked per record the second record ' +
      'of the same Task says no.'
    let cloud = 0
    let documents = 0
    const { adapter, audit, core, start, procFor } = newCore({
      usedCloudReach: () => cloud++ === 0,
      usedDocumentReach: () => documents++ === 0,
    })

    const { task, proc } = await start('hello')
    feed(proc, [...ofKind(COMPACTED, 'system/compact_boundary'), ...BLOCKED_WITH_OVERAGE])
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect([cloud, documents], why).toEqual([1, 1])
    expect(recordsIn(audit), why).toMatchObject([
      { cloudReach: true, documentReach: true },
      { cloudReach: true, documentReach: true },
    ])
  })

  it('bills the blocked attempt to the credential that was actually paying', async () => {
    const { adapter, audit, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_HAVING_SPENT)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(audit.totalFor(MONTH, 'overflow')).toMatchObject({
      tasks: 1,
      costUsd: expect.closeTo(0.0103129, 7),
    })
    expect(audit.totalFor(MONTH, 'shared-window')).toMatchObject({
      tasks: 1,
      costUsd: expect.closeTo(0.02, 7),
    })
    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'result',
      overflowCostUsd: expect.closeTo(0.0103129, 7),
    })
  })

  it('files the two halves under one Task id', async () => {
    const { adapter, audit, core, start, procFor } = newCore()

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_HAVING_SPENT)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
    await task

    const records = recordsIn(audit)
    expect(records.map((record) => record.credential)).toEqual(['overflow', 'shared-window'])
    expect(new Set(records.map((record) => record.taskId)).size).toBe(1)
  })
})

describe('the monthly Overflow cap', () => {
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

  it('leaves the refused Task waiting for the window rather than ending it', async () => {
    const { adapter, audit, core, start, procFor } = newCore({
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
    feed(procFor(KEY), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result' })
  })

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

  it('is measured on per-Turn costs, so spend below it is still allowed', async () => {
    const { adapter, audit, core, start, procFor } = newCore({
      overflow: { monthlyCapUsd: 5 },
    })
    alreadySpent(audit, 1)

    const { task, proc } = await start('hello')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()
    await core.takeOverflow(taskIdOf(adapter))
    await flush()
    feed(procFor(KEY), OK)
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

function coreSources(): Source[] {
  return sources().filter(({ file }) => !file.split(sep).includes('channels'))
}

const FREE_RELAY = recordedStream('readout-context').turn(1)

const TASK_COST = totalCostOf(OK)

function totalCostOf(events: readonly ClaudeEvent[]): number {
  const total = events.at(-1)?.['total_cost_usd']
  if (typeof total !== 'number') throw new Error('that capture does not end on a priced result')
  return total
}

const FREE_RELAY_DRIFTED = FREE_RELAY.map((event) =>
  event.type === 'result'
    ? {
        ...event,
        num_turns: 0,
        total_cost_usd: 0.0549,
        modelUsage: {
          'claude-sonnet-5': { inputTokens: 2019, outputTokens: 1978, costUSD: 0.0549 },
        },
      }
    : event,
)

describe('relaying a free Relay', () => {
  it('sends the command first and the Caller after it', async () => {
    const { claude, say } = newCore()

    await say('/context', { events: FREE_RELAY })

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '/context\n\n<from>Ada (users/17)</from>' }] },
    })
  })

  it('sends the spelling roma chose, not the one that was typed', async () => {
    const { claude, say } = newCore()

    await say('  /CONTEXT ', { events: FREE_RELAY })

    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '/context\n\n<from>Ada (users/17)</from>' }] },
    })
  })

  it('posts what Claude Code said', async () => {
    const { adapter, say } = newCore()

    await say('/context', { events: FREE_RELAY })

    const last = posted(adapter.instructions).at(-1)
    expect(last).toMatchObject({ kind: 'result', conversationKey: KEY })
    expect((last as { text: string }).text).toContain('Context Usage')
  })

  it('opens the Session, because a Relay is a message that starts one', async () => {
    const { adapter, say } = newCore()

    await say('/context', { events: FREE_RELAY })

    expect(openingsIn(adapter.instructions)).toHaveLength(1)
    expect(adapter.instructions.at(0)).toMatchObject({ kind: 'result' })
  })

  it('is written down, as a Relay rather than as a Task', async () => {
    const { audit, say } = newCore()

    await say('hello')
    await say('/context', { events: withTotalCostUsd(FREE_RELAY, TASK_COST) })

    const records = recordsIn(audit)
    expect(records.map((record) => record.kind)).toEqual([undefined, 'relay'])
    expect(records.at(-1)).toMatchObject({
      kind: 'relay',
      caller: 'users/17',
      callerName: 'Ada',
      outcome: 'result',
      costUsd: 0,
      credential: 'shared-window',
      caveman: CAVEMAN_NOT_PINNED,
      outputTokens: 0,
    })
    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 1, relays: 1 })
    expect(records.map((record) => record.runtime)).toEqual(['claude-code', 'claude-code'])
  })

  it('says nothing first when the Session already has a process', async () => {
    const { adapter, say } = newCore()

    await say('hello')
    const before = progressOf(adapter).length

    await say('/context', { events: FREE_RELAY })

    expect(progressOf(adapter).length).toBe(before)
  })

  it('says it is waiting when the Session is busy', async () => {
    const { adapter, procFor, start, core, claude } = newCore()

    const { task } = await start('a long one')

    const relay = core.handle(ingress('/context'))
    await flush()

    expect(queuedIn(adapter)).toHaveLength(1)

    feed(procFor(KEY), OK)
    await task
    await flush()
    feed(claude.process, FREE_RELAY)
    await relay
  })

  it('tells an operator when a free Relay did model work [fence:core-free-relay-drift-is-one-way]', async () => {
    const why =
      'The free-Relay drift check is keyed on output tokens, not num_turns (ADR-0012, ' +
      'ADR-0018): a /compact spends five cents at num_turns 0, so a check keyed on ' +
      'Turns cannot see a free entry start doing model work after the pin moves.'
    const { adapter, log, say } = newCore()

    await say('/context', { events: FREE_RELAY_DRIFTED })

    expect(log, why).toEqual([
      {
        event: 'free-relay-did-model-work',
        taskId: expect.any(String),
        command: '/context',
        outputTokens: 1978,
        costUsd: 0.0549,
      },
    ])
    expect(posted(adapter.instructions).at(-1), why).toMatchObject({ kind: 'result' })
  })

  it('says nothing to an operator about a free Relay that behaved', async () => {
    const { log, say } = newCore()

    await say('/context', { events: FREE_RELAY })

    expect(log).toEqual([])
  })

  it('puts a drifted Relay’s cost into the month', async () => {
    const { audit, say } = newCore()

    await say('/context', { events: FREE_RELAY_DRIFTED })

    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 0, relays: 1, costUsd: 0.0549 })
  })

  it('puts what a drifted Relay produced on its record', async () => {
    const { audit, say } = newCore()

    await say('/context', { events: FREE_RELAY_DRIFTED })

    expect(recordsIn(audit).at(-1)).toMatchObject({ kind: 'relay', outputTokens: 1978 })
  })
})

describe('relaying a `/compact`, which costs money', () => {
  it('sends the command first and the Caller after it, with no argument', async () => {
    const { claude, say } = newCore()

    await say('/compact', { events: COMPACTED_MANUALLY })

    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '/compact\n\n<from>Ada (users/17)</from>' }] },
    })
  })

  it('sends an argument with no marker at all', async () => {
    const { claude, say } = newCore()

    await say('/compact keep the ADRs and anything unresolved', {
      events: COMPACTED_MANUALLY,
    })

    expect(claude.process.sent.at(-1)).toMatchObject({
      message: { content: [{ text: '/compact\n\nkeep the ADRs and anything unresolved' }] },
    })
    expect(JSON.stringify(claude.process.sent.at(-1))).not.toContain('<from>')
  })

  it('is written down as a Relay that cost money, with the Compaction on it', async () => {
    const { audit, say } = newCore()

    await say('/compact', { events: COMPACTED_MANUALLY })

    expect(recordsIn(audit)).toMatchObject([
      {
        kind: 'relay',
        caller: 'users/17',
        callerName: 'Ada',
        outcome: 'result',
        credential: 'shared-window',
        compaction: { trigger: 'manual', preTokens: 31953, postTokens: 1764 },
      },
    ])
    expect(recordsIn(audit).at(0)?.costUsd).toBeGreaterThan(0)
    expect(audit.totalFor(MONTH)).toMatchObject({ tasks: 0, relays: 1 })
  })

  it('reports no Turns at all, which is what re-keyed the drift check [fence:core-free-relay-drift-is-one-way]', async () => {
    const why =
      'The drift check runs on the free path only (ADR-0018): a paid Relay doing model ' +
      'work is what it is for, and checking it in either direction reports drift on ' +
      'every /compact.'
    const { audit, log, say } = newCore()

    await say('/compact', { events: COMPACTED_MANUALLY })

    expect(COMPACTED_MANUALLY.at(-1), why).toMatchObject({ num_turns: 0 })
    expect(log, why).toEqual([])
    expect(recordsIn(audit).at(0)?.costUsd, why).toBeGreaterThan(0)
  })

  it('says what the money bought, in the boundary’s own figures', async () => {
    const { adapter, say } = newCore()

    await say('/compact', { events: COMPACTED_MANUALLY })

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'Compacted: 31,953 → 1,764 tokens.',
    })
  })

  it('groups its figures the same whatever locale roma runs under [fence:core-token-counts-ignore-locale]', async () => {
    const why =
      'Token counts are grouped by roma, never by toLocaleString (ADR-0018): its grouping ' +
      'and separator follow the locale the process happens to run under, and this sentence ' +
      'is a Conversation’s rather than a machine’s.'
    const { adapter, say } = newCore()
    const german = new Intl.NumberFormat('de-DE')
    const localised = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
    ) {
      return german.format(this)
    })

    try {
      await say('/compact', { events: COMPACTED_MANUALLY })
    } finally {
      localised.mockRestore()
    }

    expect(posted(adapter.instructions).at(-1), why).toMatchObject({
      text: 'Compacted: 31,953 → 1,764 tokens.',
    })
  })

  it('still says it compacted when the boundary carried no figures [fence:core-relay-reply-never-silent]', async () => {
    const why =
      'A Compaction that happened is said even without its figures (ADR-0018): a ' +
      'successful /compact returns an empty result, so roma has to speak.'
    const { adapter, say } = newCore()

    await say('/compact', { events: withoutCompactionTokens(COMPACTED_MANUALLY) })

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'Compacted.',
    })
  })

  it('says something even when Claude Code says nothing at all [fence:core-relay-reply-never-silent]', async () => {
    const why =
      "A Relay's reply is split on whether a Compaction happened, never on matching " +
      'compact_error, and is never empty (ADR-0018): compact_error is a code on one ' +
      'path and a sentence on the other, and silence after half a minute and five cents ' +
      'produces a resend.'
    const { adapter, say } = newCore()

    await say('/compact', { events: withResultText(MANUAL_COMPACTION_REFUSED, '') })

    expect(posted(adapter.instructions).at(-1), why).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'That command finished, and Claude Code said nothing about it.',
    })
  })

  it('acknowledges it even on a warm Session, and says it is compacting', async () => {
    const { adapter, say, start } = newCore()

    await say('hello')
    const before = progressOf(adapter).length

    const { task, proc } = await start('/compact')
    expect(
      progressOf(adapter)
        .slice(before)
        .map(({ progress }) => progress),
    ).toEqual([{ phase: 'working' }])

    feed(proc, upToFirst(COMPACTED_MANUALLY, 'system/compact_boundary'))
    await vi.advanceTimersByTimeAsync(THROTTLE)

    expect(adapter.instructions.at(-1)).toMatchObject({
      kind: 'progress',
      progress: { phase: 'compacting' },
    })

    feed(proc, COMPACTED_MANUALLY.slice(-1))
    await task
  })

  it('can be stopped, which a free Relay cannot', async () => {
    const { adapter, core, start } = newCore()
    const INTERRUPTED = recordedStream('interrupted-turn')
    const { task, proc } = await start('/compact')

    await core.handle(ingress('/stop'))
    feed(proc, INTERRUPTED.turn(1))
    await task

    expect(posted(adapter.instructions)).toContainEqual({
      kind: 'command-outcome',
      conversationKey: KEY,
      command: 'stop',
      carriedOut: true,
    })
    expect(posted(adapter.instructions).at(-1)).toEqual({ kind: 'stopped', conversationKey: KEY })
  })

  it('holds one of the three concurrency slots while it runs', async () => {
    const { queue, start } = newCore()

    const { task, proc } = await start('/compact')
    expect(queue.running).toBe(1)

    feed(proc, COMPACTED_MANUALLY)
    await task
    expect(queue.running).toBe(0)
  })

  it('is offered Overflow when the window blocks it, like anything else', async () => {
    const { adapter, start } = newCore()

    const { task, proc } = await start('/compact keep the ADRs')
    feed(proc, BLOCKED_WITH_OVERAGE)
    await flush()

    expect(posted(adapter.instructions)).toContainEqual({
      kind: 'blocked',
      conversationKey: KEY,
      resetsAt: RESETS_AT,
      overflowOffered: true,
    })
    leftParked(task)
  })
})

describe('a `/compact` that did not compact', () => {
  it('writes no operator line, because roma is not the one classifying it [fence:core-manual-compaction-is-the-callers]', async () => {
    const why =
      "A Compaction that fails inside a /compact is the Relay's own answer, never " +
      'classified by roma and never checked for work it did not do (ADR-0018, ' +
      'ADR-0019): the manual path sends a sentence where the auto path sends a code, so ' +
      'classifying it, or a two-directional drift check, writes an operator line every ' +
      'time somebody /compacts a short thread.'
    const { log, say } = newCore()

    await say('/compact', { events: MANUAL_COMPACTION_REFUSED })

    expect(log, why).toEqual([])
  })

  it('relays Claude Code’s own sentence to whoever asked', async () => {
    const { adapter, say } = newCore()

    await say('/compact', { events: MANUAL_COMPACTION_REFUSED })

    expect(posted(adapter.instructions).at(-1)).toEqual({
      kind: 'result',
      conversationKey: KEY,
      text: 'Not enough messages to compact.',
    })
  })

  it('says nothing of its own about one that sounds serious [fence:core-manual-compaction-is-the-callers]', async () => {
    const why =
      "A Compaction that fails inside a /compact is the Relay's own answer (ADR-0018): " +
      'roma cannot tell a serious code from the benign sentence without reading ' +
      'sentences, so it classifies neither.'
    const { adapter, log, say } = newCore()
    const exhausted = withCompactionError(
      MANUAL_COMPACTION_REFUSED,
      'Compaction failed · conversation could not be reduced below the context limit',
    )

    await say('/compact', { events: exhausted })

    expect(log, why).toEqual([])
    expect(posted(adapter.instructions), why).not.toContainEqual(
      expect.objectContaining({ kind: 'context-full' }),
    )
  })

  it('leaves the classifier alone for a Compaction nobody asked for', async () => {
    const { adapter, log, say } = newCore()

    await say('OK', { events: withCompactionError(COMPACTION_FAILED, 'exhausted') })

    expect(log).toMatchObject([{ event: 'compaction-failed', severity: 'unreducible' }])
    expect(posted(adapter.instructions)).toContainEqual({
      kind: 'context-full',
      conversationKey: KEY,
    })
  })
})

describe('what somebody sent along with a message', () => {
  const withEnclosures = (
    text: string,
    enclosures: readonly PendingEnclosure[],
  ): IngressMessage => ({ ...ingress(text), enclosures })

  const sent = (name: string, content: string): PendingEnclosure => ({
    name,
    from: null,
    redeem: () => Promise.resolve(new TextEncoder().encode(content)),
  })

  const spawned = async (procFor: (key: string) => FakeClaudeProcess) => {
    for (let waited = 0; waited < 5_000; waited += 5) {
      await flush()
      try {
        return procFor(KEY)
      } catch {
        await sleep(5)
      }
    }
    throw new Error('nothing was spawned')
  }

  const textOf = (frame: Record<string, unknown> | undefined): string => {
    const message = frame?.['message'] as { content?: { text?: string }[] } | undefined
    return message?.content?.[0]?.text ?? ''
  }

  it('writes it into the Session’s Working Directory and names it to the agent [fence:core-enclosure-path-is-minted]', async () => {
    const why =
      "An Enclosure's file is named by roma, never by the sender's contentName " +
      '(ADR-0011): a name chosen by whoever sent the message is a path traversal and a ' +
      'collision between two screenshot.png.'
    const { core, procFor, workRoot } = newCore()

    const task = core.handle(withEnclosures('what is this?', [sent('screenshot.png', 'PNG')]))
    const proc = await spawned(procFor)
    feed(proc, OK)
    await task

    const cwd = join(workRoot, sessionIdFor(KEY))
    const [file] = readdirSync(join(cwd, '.enclosures'))
    expect(readFileSync(join(cwd, '.enclosures', file!), 'utf8'), why).toBe('PNG')
    expect(file, why).not.toContain('screenshot')
    expect(textOf(proc.sent.at(0)), why).toContain(
      `<enclosure path="./.enclosures/${file}" name="screenshot.png" />`,
    )
  })

  it('redeems it once, and not before the Session is known', async () => {
    const { core, procFor } = newCore()
    let redemptions = 0
    const counted: PendingEnclosure = {
      name: 'a.png',
      from: null,
      redeem: () => {
        redemptions += 1
        return Promise.resolve(new Uint8Array([1]))
      },
    }

    const message = withEnclosures('look', [counted])
    expect(redemptions).toBe(0)

    const task = core.handle(message)
    feed(await spawned(procFor), OK)
    await task

    expect(redemptions).toBe(1)
  })

  it('fetches nothing for a message whose Session cannot be worked out [fence:core-enclosures-redeemed-late]', async () => {
    const why =
      'An Enclosure is redeemed only once the Session is known, immediately before it is ' +
      'written (ADR-0011): fetched on arrival, bytes sized by whoever sent them are paid ' +
      'for, and held, by a message that never reaches a Turn.'
    const { core, workRoot } = newCore()
    writeFileSync(join(workRoot, `${sessionIdFor(KEY)}.generation`), 'half a wr')
    let redemptions = 0
    const counted: PendingEnclosure = {
      name: 'a.png',
      from: null,
      redeem: () => {
        redemptions += 1
        return Promise.resolve(new Uint8Array([1]))
      },
    }

    await core.handle(withEnclosures('look', [counted]))

    expect(redemptions, why).toBe(0)
  })

  it('fetches none for a Relay, which has nowhere to name it [fence:core-relay-redeems-nothing]', async () => {
    const why =
      'A Relay redeems no Enclosure (ADR-0012, ADR-0018): it goes on the wire as a command ' +
      'with nowhere to name a file, so bytes fetched for it are paid for and mentioned to ' +
      'nobody.'
    const { claude, core, procFor } = newCore()
    let redemptions = 0
    const counted: PendingEnclosure = {
      name: 'a.png',
      from: null,
      redeem: () => {
        redemptions += 1
        return Promise.resolve(new Uint8Array([1]))
      },
    }

    const task = core.handle(withEnclosures('/compact', [counted]))
    feed(await spawned(procFor), COMPACTED_MANUALLY)
    await task

    expect(redemptions, why).toBe(0)
    expect(claude.process.sent.at(-1), why).toMatchObject({
      message: { content: [{ text: '/compact\n\n<from>Ada (users/17)</from>' }] },
    })
  })

  it('fails the Task, with the reason, when one cannot be fetched', async () => {
    const { core, adapter } = newCore()
    const unreachable: PendingEnclosure = {
      name: 'design.fig',
      from: null,
      redeem: () => Promise.reject(new Error('roma has no Drive scope')),
    }

    await core.handle(withEnclosures('review this', [unreachable]))

    expect(posted(adapter.instructions).at(-1)).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('no Drive scope'),
    })
  })

  it('spawns nothing for a Task whose Enclosure could not be fetched', async () => {
    const { core, claude } = newCore()
    const unreachable: PendingEnclosure = {
      name: 'design.fig',
      from: null,
      redeem: () => Promise.reject(new Error('gone')),
    }

    await core.handle(withEnclosures('review this', [unreachable]))

    expect(claude.spawns).toHaveLength(0)
  })

  it('creates the Session for a first message that carries one', async () => {
    const { core, claude, procFor } = newCore()

    const task = core.handle(withEnclosures('what is this?', [sent('shot.webp', 'PNG')]))
    feed(await spawned(procFor), OK)
    await task

    expect(claude.spawns).toHaveLength(1)
    expect(claude.lastSpawn.args).toContain('--session-id')
    expect(claude.lastSpawn.args).not.toContain('--resume')
  })

  it('answers that first message rather than failing it', async () => {
    const { core, adapter, procFor } = newCore()

    const task = core.handle(withEnclosures('what is this?', [sent('shot.webp', 'PNG')]))
    feed(await spawned(procFor), OK)
    await task

    expect(posted(adapter.instructions).at(-1)).toMatchObject({ kind: 'result', text: 'ok' })
  })
})

describe('the message a message quotes', () => {
  const withQuotation = (text: string, quotation: Quotation): IngressMessage => ({
    ...ingress(text),
    quotation,
  })

  const BOB_SAID: Quotation = {
    text: 'the deploy failed at step 3',
    author: 'Bob (users/99)',
  }

  it('names it to the agent, under the Caller Marker and above what was typed', async () => {
    const { core, claude, procFor } = newCore()

    const task = core.handle(withQuotation('why did this happen?', BOB_SAID))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: {
        content: [
          {
            text:
              '<from>Ada (users/17)</from>\n' +
              '<quoted from="Bob (users/99)">the deploy failed at step 3</quoted>\n' +
              '\n' +
              'why did this happen?',
          },
        ],
      },
    })
  })

  it('leaves a Command a Command [fence:core-command-ignores-the-quotation]', async () => {
    const why =
      'A quotation travels beside the text and is never spliced into it (ADR-0021): ' +
      'readCommand matches the whole message, so quoting something and typing /stop ' +
      'would stop meaning /stop.'
    const { core, adapter, claude, start } = newCore()
    const { task, proc } = await start('take a while')

    await core.handle(withQuotation('/stop', BOB_SAID))

    expect(proc.sent.at(-1), why).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    feed(proc, recordedStream('interrupted-turn').turn(1))
    await task

    expect(posted(adapter.instructions), why).toContainEqual({
      kind: 'command-outcome',
      conversationKey: KEY,
      command: 'stop',
      carriedOut: true,
    })
    expect(claude.spawns, why).toHaveLength(1)
  })

  it('carries none of it on a Relay, which goes on the wire as a command', async () => {
    const { core, claude, procFor } = newCore()

    const task = core.handle(withQuotation('/compact', BOB_SAID))
    await flush()
    feed(procFor(KEY), OK)
    await task

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '/compact\n\n<from>Ada (users/17)</from>' }] },
    })
  })

  it('changes nothing about a message that quotes nothing', async () => {
    const { claude, say } = newCore()

    await say('fix the CI')

    expect(claude.process.sent.at(-1)).toMatchObject({
      type: 'user',
      message: { content: [{ text: '<from>Ada (users/17)</from>\n\nfix the CI' }] },
    })
  })
})
