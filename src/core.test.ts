import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Core } from './core.js'
import type { IngressMessage } from './channel-adapter.js'
import { sessionIdFor } from './session-id.js'
import { SessionPool } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
import { FakeClaude, flush } from '../test/support/fake-claude.js'
import { RecordingAdapter } from '../test/support/recording-adapter.js'
import { feed, recordedStream } from '../test/support/recorded-stream.js'

const stream = recordedStream('three-turns-one-process')
/** One complete Turn of a real recorded stream. Its text is "ok". */
const OK = stream.turn(1)
const FAILED = recordedStream('auth-failure').turn(1)

const KEY = 'conversation-one'
const OTHER_KEY = 'conversation-two'

let pools: SessionPool[] = []
let workRoots: string[] = []

function newCore({ workRoot = mkdtempSync(join(tmpdir(), 'roma-core-')) } = {}) {
  const claude = new FakeClaude({ exitOnKill: true })
  workRoots.push(workRoot)
  const pool = new SessionPool({
    workRoot,
    env: { PATH: '/usr/bin' },
    spawn: claude.spawn,
    log: () => {},
  })
  pools.push(pool)

  const adapter = new RecordingAdapter()
  const core = new Core({ channel: adapter, pool })

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

  return { adapter, claude, core, pool, workRoot, say }
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
    const { pool, claude, workRoot } = newCore()
    // A second Core over the same pool: one Core per Channel is what keeps the
    // Core free of Channel identity, and the pool is shared between them.
    const core = new Core({
      channel: {
        capabilities: { messageMutation: true, stableConversationKey: true },
        toIngress: (event: IngressMessage) => event,
        deliver: () => {
          throw new Error('the Channel is down')
        },
      },
      pool,
    })

    const task = core.runTask(ingress('hello'))
    await flush()
    feed(claude.processFor(join(workRoot, sessionIdFor(KEY))), OK)

    await expect(task).rejects.toThrow('the Channel is down')
  })
})

describe('knowing nothing about which Channel a message came from', () => {
  it('refuses a Channel that cannot supply a stable Conversation Key', () => {
    const { pool } = newCore()
    const adapter = new RecordingAdapter({ stableConversationKey: false })

    expect(() => new Core({ channel: adapter, pool })).toThrow(/stable/i)
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
