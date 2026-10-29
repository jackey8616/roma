import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RetryStormError,
  SessionPool,
  type PoolLogRecord,
  type SessionCavemen,
  type SessionEfforts,
  type SessionModels,
  type SessionPoolOptions,
} from './session-pool.js'
import type { CredentialKind } from './build-env.js'
import { cavemanRuleset } from './caveman.js'
import type { Turn } from './claude-session.js'
import { FakeClaude, flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'
import {
  feed,
  OK,
  recordedStream,
  RESUME_LOST,
  RETRIES,
  THREE_TURNS,
  withTotalCostUsd,
} from '../test/support/recorded-stream.js'
import type { ClaudeEvent } from './stream-events.js'
import { WorkRoot } from './work-root.js'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Session ids are uuids in production; only their distinctness matters here. */
function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const A = sessionId(1)
const B = sessionId(2)

/**
 * Leave behind what a Session that has been spawned before leaves behind.
 *
 * Written here rather than by making the directory, because the two stopped
 * being the same thing in #105: anything may create a Working Directory — an
 * Enclosure written before the Turn does — and only the pool writes this. A test
 * that still said `mkdirSync` would be asserting against the invariant that
 * broke.
 */
function spawnedBefore(workRoot: string, id: string): void {
  mkdirSync(join(workRoot, id), { recursive: true })
  writeFileSync(join(workRoot, id, '.roma-session'), '')
}

const DETACHED =
  'A termination nobody awaits — the retry-storm abandon, the reap timer — must carry its own ' +
  '.catch (ADR-0003). Without it a rejecting termination is an unhandled rejection, and ' +
  'Node 22 ends the process on one: every Session and every running Task with it (#21, #23).'

/** Rejections nobody handled while `act` ran, collected rather than left to end the run. */
async function unhandledDuring(act: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const collect = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', collect)
  try {
    await act()
    await flush()
    await flush()
  } finally {
    process.off('unhandledRejection', collect)
  }
  return unhandled
}

let pools: SessionPool[] = []
let workRoots: string[] = []

// The path rather than the Work Root, because almost every test below asserts on
// where something landed and does that by building the path itself. Handing the
// helper a string and letting it wrap one keeps those assertions independent of
// the module under test — a test that located a directory with `sessionDir`
// would agree with it by construction.
function newPool(
  options: Partial<Omit<SessionPoolOptions, 'workRoot'>> & { readonly workRoot?: string } = {},
) {
  const claude = new FakeClaude({ exitOnKill: true })
  const workRoot = options.workRoot ?? mkdtempSync(join(tmpdir(), 'roma-pool-'))
  workRoots.push(workRoot)
  const log: PoolLogRecord[] = []
  const pool = new SessionPool({
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
    log: (record) => log.push(record),
    ...options,
    // After the spread: `options.workRoot` is a path and this one is the object.
    workRoot: new WorkRoot(workRoot),
  })
  pools.push(pool)

  const processFor = (id: string): FakeClaudeProcess => claude.processFor(join(workRoot, id))

  /** Send a message and serve the Turn it drives from a recorded stream. */
  const send = async (
    id: string,
    text: string,
    events: readonly ClaudeEvent[],
    credential?: CredentialKind,
  ): Promise<Turn> => {
    const turn = credential === undefined ? pool.send(id, text) : pool.send(id, text, credential)
    await flush()
    feed(processFor(id), events)
    return await turn
  }

  return { claude, pool, workRoot, log, processFor, send }
}

beforeEach(() => {
  // setImmediate stays real so `flush` can still drain the microtask queue while
  // the reap and reclaim timers are under the test's control.
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

describe('one working directory per Session', () => {
  it('runs each Session in its own directory under the work root [fence:pool-a-session-works-in-its-own-directory]', async () => {
    const why =
      'Every Session must be spawned in a Working Directory of its own, named by its Session ' +
      'id (CONTEXT.md, Working Directory). A directory two Sessions share is one their agents ' +
      'clone into concurrently, so each corrupts the other’s checkouts with symptoms that are ' +
      'very hard to diagnose, and one Session’s spawn file makes the other look already created.'
    const { claude, workRoot, send } = newPool()

    await send(A, 'hello', OK)
    await send(B, 'hello', OK)

    expect(
      claude.spawns.map((spawn) => spawn.cwd),
      why,
    ).toEqual([join(workRoot, A), join(workRoot, B)])
    expect(existsSync(join(workRoot, A)), why).toBe(true)
    expect(existsSync(join(workRoot, B)), why).toBe(true)
  })

  it('gives every process the environment it was built with, and nothing else', async () => {
    const { claude, send } = newPool()

    await send(A, 'hello', OK)

    expect(claude.lastSpawn.env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ROMA_SESSION_ID: A,
    })
  })

  // Which Session a process is serving is the one thing its environment cannot
  // be built once and shared for. A Credential Shim reports it, and roma
  // resolves it to a Task through the Task Queue — so a pool that handed every
  // process the same map would attribute every credential request in roma to
  // whichever Session happened to be named in it.
  it('tells each process which Session it is', async () => {
    const { claude, send } = newPool()

    await send(A, 'hello', OK)
    await send(B, 'hello', OK)

    expect(claude.spawns.map(({ env }) => env['ROMA_SESSION_ID'])).toEqual([A, B])
  })
})

describe('naming a Session versus reaching it again', () => {
  const SPAWN_FILE =
    'Whether a Session was spawned before is read off the file the pool writes inside its ' +
    'Working Directory, never off the directory existing (ADR-0011, ADR-0003). An Enclosure ' +
    'written before the first Turn makes the directory, and every later message then ' +
    '--resumes a Transcript nobody wrote (#105); and kept outside the directory, the record ' +
    'survives the seven-day reclaim that took the directory, so the next message resumes ' +
    'instead of creating.'
  const CARRIED =
    'The reason a correction gives must be carried on it, never read off stderr when the ' +
    'record is written (ADR-0005). In production the refusal settles the Turn from a terminal ' +
    'event on stdout, and stderr arrives on another pipe with no guarantee of having landed, ' +
    'so the operator record is blank in exactly the case it was added for (#107).'
  const RECOVERS =
    'A spawn whose flag was wrong about whether the Session exists must be retried once with ' +
    'the other flag, decided from what the CLI said (ADR-0003, ADR-0006). Left alone, a ' +
    'Session that died before its Transcript was written, or one whose directory was ' +
    'reclaimed, poisons its Conversation for good: every later message repeats the refused ' +
    'spawn (#51).'
  const ONCE =
    'The wrong-flag correction is bounded to once per Turn by a carried `corrected`, not ' +
    'inferred (ADR-0003). Each correction flips the flag, so a CLI refusing both is otherwise ' +
    'answered --session-id, --resume, --session-id for ever — and #spawn is serialised, so the ' +
    'loop starves every other Session too (#51).'

  it('creates a Session with --session-id and reaches it again with --resume', async () => {
    const { claude, pool, send } = newPool()

    await send(A, 'first', OK)
    await pool.evict(A)
    await send(A, 'second', OK)

    expect(claude.spawns[0]?.args).toContain('--session-id')
    expect(claude.spawns[0]?.args).not.toContain('--resume')
    expect(claude.spawns[1]?.args).toContain('--resume')
    expect(claude.spawns[1]?.args).not.toContain('--session-id')
  })

  // What the pool left in the working directory is the Session's record that it
  // exists, which is what makes the rule survive a restart of roma itself. An
  // in-memory flag would send --session-id at an id that already has a
  // transcript.
  it('resumes a Session whose working directory outlived the pool', async () => {
    const { workRoot } = newPool()
    spawnedBefore(workRoot, A)
    const { claude, send } = newPool({ workRoot })

    await send(A, 'after a restart', OK)

    expect(claude.lastSpawn.args).toContain('--resume')
  })

  // The record can still be ahead of the Transcript, whatever it is read off:
  // roma writes it at the spawn, and a process that died before Claude Code
  // wrote its transcript leaves a Session that looks created and is not. Left
  // alone, that Conversation is poisoned for good.
  it('starts a fresh Session when the transcript the resume wanted is gone [fence:pool-wrong-flag-recovers]', async () => {
    const { claude, pool, workRoot, processFor, log } = newPool()
    spawnedBefore(workRoot, A)

    const turn = pool.send(A, 'hello')
    await flush()
    const resumed = processFor(A)
    resumed.emitStderr(`No conversation found with session ID: ${A}\n`)
    resumed.emitExit({ code: 1, signal: null })
    await flush()
    feed(processFor(A), OK)

    expect((await turn).text, RECOVERS).toBe('ok')
    expect(claude.spawns[0]?.args, RECOVERS).toContain('--resume')
    expect(claude.spawns[1]?.args, RECOVERS).toContain('--session-id')
    // The whole record, not just its name. An operator reading this needs the
    // flag roma retried with as well as what it found, and `retryWith` is the
    // only part that says what roma *did* — the rest of the trail is two spawn
    // records they would have to pair up themselves.
    expect(log, RECOVERS).toContainEqual({
      event: 'resume-lost',
      sessionId: A,
      refusal: expect.stringContaining('No conversation found'),
      retryWith: '--session-id',
    })
  })

  // The same loss, in the shape production actually produces it — and the shape
  // the sibling above cannot reach. That test drives stderr and an exit, which
  // is what `claude -p` does; every measurement of this failure was taken that
  // way (`claude-session.live.test.ts` runs `-p` alone). Under the invocation
  // roma really spawns, `--output-format stream-json` puts a terminal `result`
  // with `is_error` on *stdout* as well, and it settles the Turn first — so the
  // pool is handed a `TurnFailedError`, `#wrongFlag` refuses it for not being a
  // `ClaudeExitedError`, and the stderr it would have recognised is never read.
  //
  // The correction cannot simply widen to `TurnFailedError`: the sibling below
  // feeds a real 401 at a Session whose directory exists and requires one spawn.
  // What tells them apart is in the events — a lost resume carries `errors` and
  // no `result` text, a failed Turn carries the text and no `errors`.
  it('starts a fresh Session when the refused resume arrives as a result event [fence:pool-wrong-flag-recovers]', async () => {
    const { claude, pool, workRoot, processFor, log } = newPool()
    spawnedBefore(workRoot, A)

    const turn = pool.send(A, 'hello')
    await flush()
    const resumed = processFor(A)
    feed(resumed, RESUME_LOST)
    resumed.emitStderr(`No conversation found with session ID: ${A}\n`)
    resumed.emitExit({ code: 1, signal: null })
    await flush()
    feed(processFor(A), OK)

    expect((await turn).text, RECOVERS).toBe('ok')
    expect(claude.spawns[0]?.args, RECOVERS).toContain('--resume')
    expect(claude.spawns[1]?.args, RECOVERS).toContain('--session-id')
    expect(log, RECOVERS).toContainEqual({
      event: 'resume-lost',
      sessionId: A,
      refusal: expect.stringContaining('No conversation found'),
      retryWith: '--session-id',
    })
  })

  // The ordering the sibling above does not have to face, and production does.
  // The terminal event settles the Turn the moment it is parsed; whether the
  // matching stderr chunk has been delivered by then is not guaranteed, because
  // they are separate pipes. So the one record an operator has to read is
  // written at a moment the buffer may still be empty — which is exactly the
  // case it was added for. It carries the ending's own reason instead.
  it('says why it recovered even when no stderr was ever delivered [fence:pool-refusal-reason-is-carried]', async () => {
    const { pool, workRoot, processFor, log } = newPool()
    spawnedBefore(workRoot, A)

    const turn = pool.send(A, 'hello')
    await flush()
    // The whole refusal, on stdout, and nothing on stderr at all.
    feed(processFor(A), RESUME_LOST)
    await flush()
    feed(processFor(A), OK)
    await turn

    expect(log, CARRIED).toContainEqual({
      event: 'resume-lost',
      sessionId: A,
      refusal: expect.stringContaining('No conversation found'),
      retryWith: '--session-id',
    })
  })

  describe('the refusal it logs [fence:refusal-keeps-both-halves]', () => {
    const WHY =
      'The resume-lost record must carry both what the CLI wrote on stderr and the ' +
      "ending's own reason, each once (ADR-0005: the Operator Log is what roma decided, " +
      'and why). stderr alone loses the reason once the CLI writes a warning first; the ' +
      'reason alone throws away the only clue to a refusal nobody has met yet (#107).'

    async function refusalAfter(stderr: string): Promise<string> {
      const { pool, workRoot, processFor, log } = newPool()
      spawnedBefore(workRoot, A)
      const turn = pool.send(A, 'hello')
      await flush()
      if (stderr !== '') processFor(A).emitStderr(stderr)
      feed(processFor(A), RESUME_LOST)
      await flush()
      feed(processFor(A), OK)
      await turn
      const record = log.find((entry) => entry.event === 'resume-lost')
      return record !== undefined && 'refusal' in record ? record.refusal : ''
    }

    it('keeps a warning the CLI wrote first, and the reason after it', async () => {
      const refusal = await refusalAfter('Warning: an unrelated deprecation\n')

      expect(refusal, WHY).toContain('Warning: an unrelated deprecation')
      expect(refusal, WHY).toContain('No conversation found')
    })

    it('does not repeat a reason stderr already carried', async () => {
      const said = 'No conversation found with session ID: a21816d1-937a-4916-a51e-f9f21b0c0950'
      const refusal = await refusalAfter(`${said}\n`)

      expect(refusal.split(said).length - 1, WHY).toBe(1)
    })
  })

  // The other thing the terminal-event ordering changes, and the one nothing
  // else would catch. A `ClaudeExitedError` correction is by definition a
  // process that has already gone; this one is a process the pool has heard
  // nothing from, so dropping it and spawning the replacement would put two
  // processes on one transcript — the corruption `#acquire` serialises to
  // prevent — and leave the first one with no reap timer to end it later.
  it('ends the refused process before it names the replacement', async () => {
    const { pool, workRoot, processFor, log } = newPool()
    spawnedBefore(workRoot, A)

    const turn = pool.send(A, 'hello')
    await flush()
    const refused = processFor(A)
    feed(refused, RESUME_LOST)
    await flush()
    feed(processFor(A), OK)
    await turn

    expect(refused.signals).toContain('SIGTERM')
    // Its ending is the pool's doing, so it is not news an operator has to read.
    expect(log).not.toContainEqual(expect.objectContaining({ event: 'exit' }))
  })

  // Defect A of #105, at the seam that decides it. Anything may create a Working
  // Directory — ADR-0011 has an Enclosure written into one before the Turn — and
  // a pool that reads the directory as the Session's record answers a first
  // message with `--resume` at a Transcript nobody has written. Every message in
  // that Conversation then fails, for free, because the Session id is derived
  // from the Conversation Key and never moves.
  it('creates the Session when something else made its working directory first [fence:pool-spawned-before-is-a-file]', async () => {
    const { claude, workRoot, send } = newPool()
    // What `writeEnclosures` leaves behind, and all of it: the directory, with
    // an Enclosure in it, and nothing the pool put there.
    mkdirSync(join(workRoot, A, '.enclosures'), { recursive: true })
    writeFileSync(join(workRoot, A, '.enclosures', 'a.webp'), 'PNG')

    await send(A, 'what is this?', OK)

    expect(claude.spawns, SPAWN_FILE).toHaveLength(1)
    expect(claude.lastSpawn.args, SPAWN_FILE).toContain('--session-id')
    expect(claude.lastSpawn.args, SPAWN_FILE).not.toContain('--resume')
  })

  // The mirror of the gap above, and the one ADR-0003 left unmeasured. Nothing
  // removes the Transcript, so a Conversation whose directory the reclaim took
  // is spawned as new at an id Claude Code still has — and refused. Measured in
  // docs/transcript-collision-verification.md: left alone that Conversation is
  // poisoned for good, because every later message repeats the same spawn.
  it('resumes a Session whose working directory was reclaimed [fence:pool-wrong-flag-recovers]', async () => {
    const { claude, pool, processFor, log } = newPool()
    // No directory made: an empty work root is what the reclaim leaves behind.

    const turn = pool.send(A, 'back after a fortnight')
    await flush()
    const refused = processFor(A)
    refused.emitStderr(`Error: Session ID ${A} is already in use.\n`)
    refused.emitExit({ code: 1, signal: null })
    await flush()
    feed(processFor(A), OK)

    expect((await turn).text, RECOVERS).toBe('ok')
    expect(claude.spawns[0]?.args, RECOVERS).toContain('--session-id')
    expect(claude.spawns[1]?.args, RECOVERS).toContain('--resume')
    // `retryWith` is the opposite of the sibling above, which is the point of
    // carrying it: the two recoveries are told apart by what roma did next, not
    // only by which refusal it saw.
    expect(log, RECOVERS).toContainEqual({
      event: 'transcript-survived',
      sessionId: A,
      refusal: expect.stringContaining('is already in use'),
      retryWith: '--resume',
    })
  })

  // The recovery is one attempt, not a loop. A retry that is refused in turn has
  // nowhere left to go — reaching for --resume was the other option — so it has
  // to surface rather than spawn forever at an id nothing will accept.
  it('gives up rather than looping when the resume is refused too [fence:pool-correction-is-once]', async () => {
    const { claude, pool, processFor } = newPool()

    const turn = pool.send(A, 'back after a fortnight')
    // Asserted before the failures are driven, not after. The Turn rejects two
    // flushes from here, and a rejection with no handler attached *at the moment
    // it rejects* is reported as unhandled even though the test goes on to
    // assert it — noise that reads like a leak in the pool and is not.
    const rejected = expect(turn, ONCE).rejects.toThrow()
    await flush()
    for (const _ of [0, 1]) {
      const refused = processFor(A)
      refused.emitStderr(`Error: Session ID ${A} is already in use.\n`)
      refused.emitExit({ code: 1, signal: null })
      await flush()
    }

    await rejected
    expect(claude.spawns, ONCE).toHaveLength(2)
  })

  // The case that actually bites, and the one driving the same error twice
  // cannot see. Each recovery flips the flag, so a CLI that refuses whichever
  // flag it is given refuses them alternately — and a pool that corrects each
  // refusal in turn walks `--session-id`, `--resume`, `--session-id` for as long
  // as it is willing to. `#spawn` is serialised, so that loop starves every
  // other Session's spawn as well as this one's.
  it('gives up when each flag is refused in turn, rather than alternating forever [fence:pool-correction-is-once]', async () => {
    const { claude, pool, processFor } = newPool()

    const turn = pool.send(A, 'back after a fortnight')
    const rejected = expect(turn, ONCE).rejects.toThrow()
    await flush()

    // Refused as new, then refused as existing: the contradiction the pool
    // cannot resolve, because reaching for the other flag was the whole remedy.
    const refusals = [
      `Error: Session ID ${A} is already in use.\n`,
      `No conversation found with session ID: ${A}\n`,
    ]
    for (const stderr of refusals) {
      const refused = processFor(A)
      refused.emitStderr(stderr)
      refused.emitExit({ code: 1, signal: null })
      await flush()
    }

    await rejected
    expect(claude.spawns, ONCE).toHaveLength(2)
    expect(claude.spawns[0]?.args, ONCE).toContain('--session-id')
    expect(claude.spawns[1]?.args, ONCE).toContain('--resume')
  })

  // Both recoveries replace a resident mid-Turn, and the outer Turn's `finally`
  // still runs afterwards on the resident it replaced. `#forget` checks identity
  // before dropping one; `#markUsed` has to check it before re-inserting, or the
  // dead resident goes back over the live one that supplanted it — leaving the
  // working process orphaned, invisible to eviction, reaping and shutdown, and
  // the next message recovering all over again.
  it('leaves the recovered process resident, not the one it replaced', async () => {
    const { claude, pool, workRoot, processFor } = newPool()
    spawnedBefore(workRoot, A)

    const turn = pool.send(A, 'hello')
    await flush()
    const resumed = processFor(A)
    resumed.emitStderr(`No conversation found with session ID: ${A}\n`)
    resumed.emitExit({ code: 1, signal: null })
    await flush()
    feed(processFor(A), OK)
    await turn

    // The Session is resident and alive, so this reuses it rather than spawning.
    const second = pool.send(A, 'and again')
    await flush()
    feed(processFor(A), OK)
    await second

    expect(claude.spawns).toHaveLength(2)
  })

  it('does not mistake a failing Turn for a lost transcript', async () => {
    const { claude, pool, workRoot, processFor } = newPool()
    spawnedBefore(workRoot, A)
    const failing = recordedStream('auth-failure')

    const turn = pool.send(A, 'hello')
    await flush()
    feed(processFor(A), failing.turn(1))

    await expect(turn).rejects.toThrow()
    expect(claude.spawns).toHaveLength(1)
  })
})

describe('staying under the resident cap', () => {
  const NEVER_BUSY =
    'Eviction must never take a Session with a Turn in flight, and must refuse loudly when ' +
    'every resident is busy (ADR-0003). A Task routinely runs for minutes with no wall-clock ' +
    'timeout; evicting it kills a running Turn and fails a Task that did nothing wrong (#21).'

  it('keeps at most ten processes resident', async () => {
    const { pool, send } = newPool()

    for (let n = 1; n <= 11; n++) await send(sessionId(n), 'hello', OK)

    expect(pool.residents).toHaveLength(10)
    expect(pool.residents).not.toContain(sessionId(1))
    expect(pool.residents).toContain(sessionId(11))
  })

  it('evicts the least recently used Session, not the least recently created', async () => {
    const { pool, send } = newPool()
    for (let n = 1; n <= 10; n++) await send(sessionId(n), 'hello', OK)

    await send(sessionId(1), 'still here', OK)
    await send(sessionId(11), 'and one more', OK)

    expect(pool.residents).toContain(sessionId(1))
    expect(pool.residents).not.toContain(sessionId(2))
  })

  // Two Tasks can be in flight at once, so two Sessions can want a slot at the
  // same moment. Each seeing the pool one short of full and taking the last slot
  // is how a cap of ten quietly becomes eleven.
  it('holds the cap when two Sessions arrive at the same moment', async () => {
    const { pool, processFor, send } = newPool({ maxResident: 2 })
    await send(A, 'hello', OK)

    const second = pool.send(sessionId(2), 'hello')
    const third = pool.send(sessionId(3), 'hello')
    await flush()
    feed(processFor(sessionId(2)), OK)
    feed(processFor(sessionId(3)), OK)
    await Promise.all([second, third])

    expect(pool.residents).toHaveLength(2)
  })

  it('evicts with SIGTERM, which is what makes a later --resume possible', async () => {
    const { claude, workRoot, send } = newPool()

    for (let n = 1; n <= 11; n++) await send(sessionId(n), 'hello', OK)

    expect(claude.processFor(join(workRoot, sessionId(1))).signals).toEqual(['SIGTERM'])
  })

  // SIGTERM exiting 143 is measured; this is the guard for the day it stops
  // holding.
  it('escalates to SIGKILL when a process ignores SIGTERM [fence:pool-eviction-kills-what-ignores-sigterm]', async () => {
    const why =
      'Eviction must end a process with terminateOrKill, never a bare terminate (ADR-0003, ' +
      'accepted risks). Eviction is awaited, so a process that ignores SIGTERM and is only ' +
      'ever asked to go stalls every later message in the pool — one wedged Session halting ' +
      'roma without a single Task hanging.'
    const { pool, processFor, log, send } = newPool()
    await send(A, 'hello', OK)
    processFor(A).ignore('SIGTERM')

    const evicted = pool.evict(A)
    await vi.advanceTimersByTimeAsync(5_000)

    // Asked before the eviction is awaited: a pool that never escalates never
    // finishes evicting either.
    expect(processFor(A).signals, why).toEqual(['SIGTERM', 'SIGKILL'])
    await evicted
    expect(log, why).toContainEqual(expect.objectContaining({ event: 'kill', sessionId: A }))
  })

  // A Task routinely runs for minutes and there is no wall-clock timeout, so the
  // one Session that must never be evicted is the one doing work.
  it('leaves a Session with a Turn in flight alone [fence:pool-busy-session-is-never-evicted]', async () => {
    const { pool, workRoot, claude, processFor, send } = newPool()
    for (let n = 1; n <= 10; n++) await send(sessionId(n), 'hello', OK)

    const inFlight = pool.send(sessionId(1), 'this one takes minutes')
    inFlight.catch(() => {})
    await flush()
    // Every other Session is used after it, so the busy one is the least
    // recently used again — and still must not be the one that goes.
    for (let n = 2; n <= 10; n++) await send(sessionId(n), 'hello again', OK)
    await send(sessionId(11), 'and one more', OK)

    expect(pool.residents, NEVER_BUSY).toContain(sessionId(1))
    expect(processFor(sessionId(1)).signals, NEVER_BUSY).toEqual([])
    expect(claude.processFor(join(workRoot, sessionId(2))).signals, NEVER_BUSY).toEqual(['SIGTERM'])
  })

  // Reached only if the Task queue's cap is ever raised to the resident cap or
  // above, since only a running Task makes a Session busy.
  it('refuses rather than evicting when every resident Session is busy [fence:pool-busy-session-is-never-evicted]', async () => {
    const { pool, processFor } = newPool({ maxResident: 1 })
    const inFlight = pool.send(A, 'this one takes minutes')
    inFlight.catch(() => {})
    await flush()

    await expect(pool.send(B, 'hello'), NEVER_BUSY).rejects.toThrow(/busy/)
    expect(processFor(A).signals, NEVER_BUSY).toEqual([])
    expect(pool.residents, NEVER_BUSY).toEqual([A])
  })

  // One spawn failing is that caller's problem. The spawns are serialised
  // through one promise, and a rejection carried along it would fail every
  // other Session's Task queued behind it.
  it('starts the next Session after one failed to start [fence:pool-failed-spawn-does-not-block-the-next]', async () => {
    const why =
      'A spawn that failed must not reject the spawns serialised behind it (ADR-0003). The ' +
      'queue of spawns is one promise; assigned without its catch, one Session that could ' +
      'not start fails every later Session’s Task (#21).'
    const { pool, send } = newPool({
      envs: {
        'shared-window': () => ({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' }),
      },
    })

    await expect(pool.send(A, 'hello', 'overflow'), why).rejects.toThrow(/overflow/i)
    expect((await send(B, 'hello', OK)).text, why).toBe('ok')
  })
})

describe('surviving eviction', () => {
  it('serves the next message from a resumed process, and the caller sees a Turn', async () => {
    const { claude, pool, send } = newPool()

    await send(A, 'first', OK)
    await pool.evict(A)
    const turn = await send(A, 'second', OK)

    expect(turn.text).toBe('ok')
    expect(claude.processes).toHaveLength(2)
    expect(pool.residents).toEqual([A])
  })

  // The trap this ticket walks into first, and the shape it turned out to have.
  // A resumed process counts its own spend from zero, so the Turn after an
  // eviction is billed what that process reports and no cost baseline crosses
  // the eviction. Measured at seam 2; the figures are in ADR-0003.
  it('bills the Turn after a resume at what the resumed process reports', async () => {
    const { pool, send } = newPool()

    const first = await send(A, 'first', OK)
    await pool.evict(A)
    const second = await send(A, 'second', withTotalCostUsd(OK, 0.0105342))

    expect(first.costUsd).toBeCloseTo(0.0103129, 7)
    expect(second.costUsd).toBeCloseTo(0.0105342, 7)
  })

  it('resumes a Session whose process died on its own', async () => {
    const { claude, pool, processFor, send } = newPool()
    await send(A, 'first', OK)

    processFor(A).emitExit({ code: 1, signal: null })
    await flush()
    await send(A, 'second', OK)

    expect(pool.residents).toEqual([A])
    expect(claude.spawns[1]?.args).toContain('--resume')
  })
})

describe('reaping idle processes', () => {
  it('does not let a failed termination escape the reap timer [fence:pool-detached-termination-is-caught]', async () => {
    const unhandled = await unhandledDuring(async () => {
      const { processFor, send } = newPool()
      await send(A, 'hello', OK)
      processFor(A).kill = () => {
        throw new Error('kill EPERM')
      }

      await vi.advanceTimersByTimeAsync(15 * MINUTE)
    })

    expect(unhandled, DETACHED).toEqual([])
  })

  it('reaps a process that has been idle for fifteen minutes', async () => {
    const { pool, processFor, send } = newPool()
    await send(A, 'hello', OK)

    await vi.advanceTimersByTimeAsync(15 * MINUTE)

    expect(pool.residents).toEqual([])
    expect(processFor(A).signals).toEqual(['SIGTERM'])
  })

  it('resumes the reaped Session cold on the next message', async () => {
    const { claude, send } = newPool()
    await send(A, 'hello', OK)
    await vi.advanceTimersByTimeAsync(15 * MINUTE)

    const turn = await send(A, 'still there?', OK)

    expect(turn.text).toBe('ok')
    expect(claude.spawns[1]?.args).toContain('--resume')
  })

  it('counts idleness from the last message, not from the spawn', async () => {
    const { pool, send } = newPool()
    await send(A, 'hello', OK)

    await vi.advanceTimersByTimeAsync(14 * MINUTE)
    await send(A, 'still here', OK)
    await vi.advanceTimersByTimeAsync(14 * MINUTE)

    expect(pool.residents).toEqual([A])
  })

  // Tasks end when they finish or when a human stops them. A Turn running longer
  // than the idle window is a slow Task, not an idle Session.
  it('never reaps a Session in the middle of a Turn', async () => {
    const { pool, processFor } = newPool()
    const turn = pool.send(A, 'this one takes an hour')
    turn.catch(() => {})
    await flush()

    await vi.advanceTimersByTimeAsync(60 * MINUTE)

    expect(pool.residents).toEqual([A])
    expect(processFor(A).signals).toEqual([])
  })
})

describe('reclaiming working directories', () => {
  it('removes a working directory idle for seven days', async () => {
    const { pool, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    await pool.evict(A)
    ageWorkDir(join(workRoot, A), 8 * DAY)

    expect(pool.reclaimIdleWorkDirs()).toEqual([A])
    expect(existsSync(join(workRoot, A))).toBe(false)
  })

  it('leaves a working directory that is younger than that', async () => {
    const { pool, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    await pool.evict(A)
    ageWorkDir(join(workRoot, A), 6 * DAY)

    expect(pool.reclaimIdleWorkDirs()).toEqual([])
    expect(existsSync(join(workRoot, A))).toBe(true)
  })

  // What roma remembers about a Conversation lives in this same directory as
  // files — its Session Generation, and since ADR-0014 its Chosen Model — and the
  // sweep must step over both. Reclaimed, a Conversation that went quiet for a
  // week would come back on a Session it was moved off, or on the Pinned Model
  // having asked for something else, at a moment nobody can observe.
  it('takes only directories, so the records beside them survive it', async () => {
    const { pool, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    await pool.evict(A)
    const records = [join(workRoot, `${A}.generation`), join(workRoot, `${A}.model`)]
    writeFileSync(records[0] ?? '', '1', 'utf8')
    writeFileSync(records[1] ?? '', 'claude-opus-5', 'utf8')
    ageWorkDir(join(workRoot, A), 8 * DAY)
    for (const record of records) ageWorkDir(record, 8 * DAY)

    expect(pool.reclaimIdleWorkDirs()).toEqual([A])
    expect(records.map((record) => existsSync(record))).toEqual([true, true])
  })

  it('leaves a resident Session alone however old its directory looks', async () => {
    const { pool, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    ageWorkDir(join(workRoot, A), 8 * DAY)

    expect(pool.reclaimIdleWorkDirs()).toEqual([])
    expect(existsSync(join(workRoot, A))).toBe(true)
  })

  // The directory holds the Session's record that it exists, so reclaiming it is
  // also what makes the next message create the Session rather than resume it.
  it('makes the next message create the Session again [fence:pool-spawned-before-is-a-file]', async () => {
    const { claude, pool, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    await pool.evict(A)
    ageWorkDir(join(workRoot, A), 8 * DAY)
    pool.reclaimIdleWorkDirs()

    await send(A, 'much later', OK)

    expect(
      claude.spawns[1]?.args,
      'The record that a Session was spawned must live inside its Working Directory, so the ' +
        'reclaim takes it along and the next message creates the Session again (ADR-0003, #105).',
    ).toContain('--session-id')
  })

  it('runs on its own rather than waiting to be asked', async () => {
    const { pool, workRoot, send } = newPool({ reclaimIntervalMs: 60 * MINUTE })
    await send(A, 'hello', OK)
    await pool.evict(A)
    ageWorkDir(join(workRoot, A), 8 * DAY)

    await vi.advanceTimersByTimeAsync(60 * MINUTE)

    expect(existsSync(join(workRoot, A))).toBe(false)
  })
})

describe('what an operator can see', () => {
  // The moment an operator is looking for is the decision, not the ending; a
  // process that will not go must not hold the record back.
  it('records an eviction before the process has gone [fence:pool-eviction-logged-before-termination]', async () => {
    const why =
      'An eviction or reap must be logged before its termination is awaited (ADR-0005: the ' +
      'Operator Log is what roma decided). A termination that hangs — a process ignoring ' +
      'SIGTERM through its grace period — otherwise swallows the only record of why a Turn ' +
      'took an extra cold start (#21).'
    const { pool, processFor, log, send } = newPool({ maxResident: 1 })
    await send(A, 'hello', OK)
    processFor(A).ignore('SIGTERM')

    const second = pool.send(B, 'hello')
    await flush()

    expect(log, why).toContainEqual(expect.objectContaining({ event: 'evict', sessionId: A }))

    await vi.advanceTimersByTimeAsync(5_000)
    feed(processFor(B), OK)
    await second
  })

  it('records an eviction, so a slow Turn has an explanation', async () => {
    const { log, send } = newPool()

    for (let n = 1; n <= 11; n++) await send(sessionId(n), 'hello', OK)

    expect(log).toContainEqual(
      expect.objectContaining({ event: 'evict', sessionId: sessionId(1), residents: 9 }),
    )
  })

  it('records a reap and how long the Session had been idle', async () => {
    const { log, send } = newPool()
    await send(A, 'hello', OK)

    await vi.advanceTimersByTimeAsync(15 * MINUTE)

    expect(log).toContainEqual(
      expect.objectContaining({ event: 'reap', sessionId: A, idleMs: 15 * MINUTE }),
    )
  })

  // The cold start an evicted Session pays on its next message — around 2.3s,
  // and the other half of the explanation for a slow Turn.
  it('records that a spawn was a resume rather than a new Session', async () => {
    const { pool, log, send } = newPool()

    await send(A, 'first', OK)
    await pool.evict(A)
    await send(A, 'second', OK)

    const spawns = log.filter((record) => record.event === 'spawn' && record.sessionId === A)
    expect(spawns).toEqual([
      expect.objectContaining({ resume: false }),
      expect.objectContaining({ resume: true }),
    ])
  })

  it('records a reclaimed working directory', async () => {
    const { pool, log, workRoot, send } = newPool()
    await send(A, 'hello', OK)
    await pool.evict(A)
    ageWorkDir(join(workRoot, A), 8 * DAY)

    pool.reclaimIdleWorkDirs()

    expect(log).toContainEqual(expect.objectContaining({ event: 'reclaim', sessionId: A }))
  })
})

describe('driving a resident Session', () => {
  it('serves a second message from the same process', async () => {
    const { claude, pool, send } = newPool()

    await send(A, 'first', OK)
    await send(A, 'second', THREE_TURNS.turn(3))

    expect(claude.processes).toHaveLength(1)
    expect(pool.residents).toEqual([A])
  })

  it('routes an interrupt to the Session it names', async () => {
    const { pool, processFor, send } = newPool()
    await send(A, 'hello', OK)
    await send(B, 'hello', OK)
    const running = pool.send(A, 'something long')
    await flush()

    expect(pool.interrupt(A)).toBe(true)

    expect(processFor(A).sent.at(-1)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    expect(processFor(B).sent).toHaveLength(1)

    feed(processFor(A), recordedStream('interrupted-turn').turn(1))
    await expect(running).rejects.toThrow()
  })

  // What `/stop` in a Conversation that is not doing anything has to be able to
  // find out. A control request sent into a Session with nothing in flight would
  // report a Task stopped that was never running.
  it('says so when there is no Turn to interrupt', async () => {
    const { pool, processFor, send } = newPool()
    await send(A, 'hello', OK)

    expect(pool.interrupt(A)).toBe(false)
    expect(pool.interrupt(B)).toBe(false)

    expect(processFor(A).sent).toHaveLength(1)
  })

  // Progress reporting reads the stream, and with more than one Session resident
  // it has to know which Session each event belongs to.
  it('re-emits stream events tagged with the Session they came from', async () => {
    const { pool, send } = newPool()
    const seen: string[] = []
    pool.on('event', (id, event) => {
      if (event.type === 'result') seen.push(id)
    })

    await send(A, 'hello', OK)
    await send(B, 'hello', OK)

    expect(seen).toEqual([A, B])
  })

  it('ends every resident process on shutdown', async () => {
    const { pool, processFor, send } = newPool()
    await send(A, 'hello', OK)
    await send(B, 'hello', OK)

    await pool.shutdown()

    expect(pool.residents).toEqual([])
    expect(processFor(A).signals).toEqual(['SIGTERM'])
    expect(processFor(B).signals).toEqual(['SIGTERM'])
  })
})

describe('giving up on a retry storm', () => {
  const budget = { maxApiRetries: 3, windowMs: 60_000 }

  // Signals and waiting cannot reject today; this is the day one does.
  it('does not let a failed termination escape as an unhandled rejection [fence:pool-detached-termination-is-caught]', async () => {
    const unhandled = await unhandledDuring(async () => {
      const { pool, processFor } = newPool({ retryBudget: budget })
      const turn = pool.send(A, 'hello')
      turn.catch(() => {})
      await flush()
      const stormed = processFor(A)
      stormed.kill = () => {
        throw new Error('kill EPERM')
      }

      feed(stormed, RETRIES.slice(0, 3))
    })

    expect(unhandled, DETACHED).toEqual([])
  })

  it('abandons a Turn that has retried more than its budget allows', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    await flush()

    feed(processFor(A), RETRIES.slice(0, 3))

    await expect(turn).rejects.toBeInstanceOf(RetryStormError)
  })

  // The whole point: the slot goes back, so a misconfigured credential cannot
  // hold one for the 182 seconds the prototype measured. Three of those halt
  // roma entirely, without a single Task hanging.
  it('releases the Session, so roma can still take new work [fence:pool-storm-ends-the-process]', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    turn.catch(() => {})
    await flush()
    const stormed = processFor(A)

    feed(stormed, RETRIES.slice(0, 3))
    await turn.catch(() => {})

    expect(
      stormed.signals,
      'A retry-storming Turn is abandoned by ending its process, never by interrupting it ' +
        '(ADR-0003). An interrupt does nothing to a process asleep in a ~35s backoff, which is ' +
        'exactly the case the cap exists for, so the slot is never given back (#23).',
    ).toEqual(['SIGTERM'])
    expect(
      pool.residents,
      'A retry-storming Turn is abandoned by ending its process, never by interrupting it ' +
        '(ADR-0003). An interrupt does nothing to a process asleep in a ~35s backoff, which is ' +
        'exactly the case the cap exists for, so the slot is never given back (#23).',
    ).toEqual([])
    expect(
      (await newTurnOn(pool, processFor, A)).text,
      'A retry-storming Turn is abandoned by ending its process, never by interrupting it ' +
        '(ADR-0003). An interrupt does nothing to a process asleep in a ~35s backoff, which is ' +
        'exactly the case the cap exists for, so the slot is never given back (#23).',
    ).toBe('ok')
  })

  // What the caller is eventually told rests on this. The 401 itself never
  // arrives — it surfaces only after all ten retries, which is the wait being
  // cut short — so the retry events are the only place the cause exists.
  it('carries the error the retries were failing on', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    await flush()

    feed(processFor(A), RETRIES.slice(0, 3))

    const error = await turn.catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({
      retries: 3,
      lastRetry: { errorStatus: 401, error: 'authentication_failed' },
    })
  })

  // The count is what fires under the observed backoff. The wall-clock is for
  // the case it would not reach — a backoff already stretched to ~35s between
  // attempts, where waiting for a count is waiting for minutes.
  it('gives up on the wall-clock when the retries are too slow to reach the count', async () => {
    const { pool, processFor, log } = newPool({
      retryBudget: { maxApiRetries: 100, windowMs: 30_000 },
    })
    const turn = pool.send(A, 'hello')
    turn.catch(() => {})
    await flush()
    feed(processFor(A), RETRIES.slice(0, 1))

    await vi.advanceTimersByTimeAsync(30_000)

    await expect(turn).rejects.toBeInstanceOf(RetryStormError)
    expect(processFor(A).signals).toEqual(['SIGTERM'])
    expect(log).toContainEqual(expect.objectContaining({ event: 'retry-storm', limit: 'window' }))
  })

  // The budget is configuration, and these are the numbers roma runs on when
  // nobody configures it. Every other test here injects its own, so without
  // this the shipped defaults are the one thing untested.
  it('gives up after five retries when nobody has configured a budget', async () => {
    const { pool, processFor } = newPool()
    const turn = pool.send(A, 'hello')
    turn.catch(() => {})
    await flush()

    feed(processFor(A), RETRIES.slice(0, 4))
    expect(pool.residents).toEqual([A])

    feed(processFor(A), RETRIES.slice(4, 5))
    await expect(turn).rejects.toMatchObject({ retries: 5 })
  })

  it('gives up after sixty seconds of retrying when nobody has configured a budget', async () => {
    const { pool, processFor } = newPool()
    const turn = pool.send(A, 'hello')
    turn.catch(() => {})
    await flush()
    feed(processFor(A), RETRIES.slice(0, 1))

    await vi.advanceTimersByTimeAsync(59_000)
    expect(pool.residents).toEqual([A])

    await vi.advanceTimersByTimeAsync(1_000)
    await expect(turn).rejects.toBeInstanceOf(RetryStormError)
  })

  // The race between the two: a Turn can finish in the gap between roma
  // deciding to stop waiting and the process actually going. An answer that
  // arrived is an answer, and throwing it away to report a storm would fail a
  // Task that had just succeeded.
  it('delivers a Turn that completes while it is being abandoned', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    await flush()
    const proc = processFor(A)
    // SIGTERM is recorded but the process does not go, so the terminal result
    // still reaches the stream.
    proc.ignore('SIGTERM')

    feed(proc, RETRIES.slice(0, 3))
    feed(proc, OK)

    expect((await turn).text).toBe('ok')
    expect(proc.signals).toContain('SIGTERM')
  })

  it('measures the wall-clock from the first retry, not from the Turn', async () => {
    const { pool, processFor } = newPool({
      retryBudget: { maxApiRetries: 100, windowMs: 30_000 },
    })
    const turn = pool.send(A, 'a long Turn that starts retrying late')
    turn.catch(() => {})
    await flush()

    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    feed(processFor(A), RETRIES.slice(0, 1))
    await vi.advanceTimersByTimeAsync(29_000)

    expect(pool.residents).toEqual([A])
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(turn).rejects.toBeInstanceOf(RetryStormError)
  })

  it('leaves a Turn that retries within its budget alone', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    await flush()

    feed(processFor(A), [...RETRIES.slice(0, 2), ...OK])

    expect((await turn).text).toBe('ok')
    expect(pool.residents).toEqual([A])
  })

  // A retry budget spent across a Session rather than a Turn would abandon a
  // healthy Conversation for a rough patch it had already recovered from.
  it('gives every Turn its budget back', async () => {
    const { pool, processFor } = newPool({ retryBudget: budget })

    const first = pool.send(A, 'first')
    await flush()
    feed(processFor(A), [...RETRIES.slice(0, 2), ...OK])
    await first

    const second = pool.send(A, 'second')
    await flush()
    feed(processFor(A), [...RETRIES.slice(2, 4), ...THREE_TURNS.turn(3)])

    await expect(second).resolves.toMatchObject({ isError: false })
    expect(pool.residents).toEqual([A])
  })

  // Retries a Turn is no longer waiting on are not that Turn's problem, and
  // there is no Turn for them to be the next one's either.
  it('ignores retries arriving with no Turn in flight', async () => {
    const { pool, processFor, send } = newPool({ retryBudget: budget })
    await send(A, 'hello', OK)

    feed(processFor(A), RETRIES.slice(0, 3))

    expect(pool.residents).toEqual([A])
    expect(processFor(A).signals).toEqual([])
  })

  it('records the storm, so an operator can see which credential caused it', async () => {
    const { pool, processFor, log } = newPool({ retryBudget: budget })
    const turn = pool.send(A, 'hello')
    turn.catch(() => {})
    await flush()

    feed(processFor(A), RETRIES.slice(0, 3))
    await turn.catch(() => {})

    expect(log).toContainEqual(
      expect.objectContaining({
        event: 'retry-storm',
        sessionId: A,
        retries: 3,
        limit: 'retries',
        status: 401,
        error: 'authentication_failed',
      }),
    )
  })
})

/** Drive one more Turn on a Session, to show the pool still serves it. */
async function newTurnOn(
  pool: SessionPool,
  processFor: (id: string) => FakeClaudeProcess,
  id: string,
): Promise<Turn> {
  const turn = pool.send(id, 'and now something that works')
  await flush()
  feed(processFor(id), OK)
  return await turn
}

/** Make a working directory look as though nothing has touched it for `ageMs`. */
function ageWorkDir(path: string, ageMs: number): void {
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}

describe('running a Turn on the other credential', () => {
  const COMPARED =
    'Every term a process is started for is compared before it is reused, through the one ' +
    '`COMPARED` table typed over SpawnTerms (ADR-0002, ADR-0014, ADR-0016, ADR-0030). A term ' +
    'checked at the spawn and forgotten in the comparison is the failure with no symptom: a ' +
    'Session served by a process started for other terms. The append is compared rather than ' +
    'the Caveman, because it is what the argv carries; the two cannot drift, because #acquire ' +
    'renders one from the other (#110, #192).'

  // Overflow is not a mode the pool is put into: ADR-0002 makes it a different
  // environment map and nothing else, so it is a property of the process serving
  // one Turn rather than of the pool or of the Session.
  it('spawns the Session on the environment the Turn asked for', async () => {
    const { claude, send } = newPool()

    await send(A, 'hello', OK, 'overflow')

    expect(claude.lastSpawn.env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'metered-key',
      ROMA_SESSION_ID: A,
    })
  })

  // The rule two processes on one Session file would break, and the reason this
  // could not simply be a second pool: the Session's transcript is one file, and
  // the process on the wrong credential has to be gone before the next one
  // starts rather than merely unused.
  it('ends the process on the old credential before starting the new one [fence:pool-every-term-is-compared]', async () => {
    const { claude, processFor, send } = newPool()
    await send(A, 'first', OK)
    const first = processFor(A)

    await send(A, 'and again', OK, 'overflow')

    expect(first.signals, COMPARED).toContain('SIGTERM')
    expect(claude.processes, COMPARED).toHaveLength(2)
  })

  // The Session survives the swap, which is what makes Overflow worth taking at
  // all: the rerun answers the message that was blocked, in the Conversation it
  // was asked in, with everything said before it still there.
  it('resumes the Session rather than starting it over', async () => {
    const { claude, send } = newPool()
    await send(A, 'first', OK)

    await send(A, 'and again', OK, 'overflow')

    expect(claude.lastSpawn.args).toContain('--resume')
    expect(claude.lastSpawn.args).toContain(A)
  })

  // Overflow applies to one Task and not to the Conversation it was taken in.
  // A pool that stayed on the metered credential would be the persistent
  // per-Conversation toggle ADR-0002 refuses, arrived at by accident.
  it('goes back to the Shared Window for the next ordinary Turn', async () => {
    const { claude, send } = newPool()
    await send(A, 'first', OK, 'overflow')

    await send(A, 'and again', OK)

    expect(claude.lastSpawn.env).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ROMA_SESSION_ID: A,
    })
  })

  it('leaves a Session alone when the next Turn wants the credential it is on', async () => {
    const { claude, send } = newPool()
    await send(A, 'first', OK, 'overflow')

    await send(A, 'and again', THREE_TURNS.turn(3), 'overflow')

    expect(claude.processes).toHaveLength(1)
  })

  // Refused rather than run on whatever is configured. A deployment with no
  // Overflow key that somehow reached this would otherwise quietly serve the
  // Turn on the Shared Window and report it as metered — which is the audit
  // record lying about which credential paid.
  it('refuses a credential it has no environment for', async () => {
    const { pool } = newPool({
      envs: {
        'shared-window': () => ({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' }),
      },
    })

    await expect(pool.send(A, 'hello', 'overflow')).rejects.toThrow(/overflow/i)
  })

  // Where money moved, and the only place it is written down as a process event
  // rather than as a Task's cost.
  it('writes the swap down for an operator', async () => {
    const { log, send } = newPool()
    await send(A, 'first', OK)

    await send(A, 'and again', OK, 'overflow')

    expect(log).toContainEqual({
      event: 'swap',
      sessionId: A,
      reason: 'credential',
      from: 'shared-window',
      to: 'overflow',
    })
  })

  // The other reason a process ends for money: `--model` is fixed at spawn too,
  // so a Session whose Chosen Model has moved needs a different process to serve
  // its next Turn. Read at the spawn rather than handed over, which is what makes
  // the invariant survive a restart nobody told the pool about.
  it('starts a new process when the Session has been moved to another model [fence:pool-every-term-is-compared]', async () => {
    const chosen = new Map<string, string>()
    const { log, send, claude } = newPool({
      models: { kind: 'model', inForce: (sessionId) => chosen.get(sessionId) ?? 'claude-sonnet-5' },
    })
    await send(A, 'first', OK)

    chosen.set(A, 'claude-opus-5')
    await send(A, 'and again', OK)

    expect(claude.lastSpawn.args, COMPARED).toContain('claude-opus-5')
    expect(log, COMPARED).toContainEqual({
      event: 'swap',
      sessionId: A,
      reason: 'model',
      from: 'claude-sonnet-5',
      to: 'claude-opus-5',
    })
  })

  /**
   * The third reason a process ends for money, and the one nothing else in roma
   * could ever notice.
   *
   * `--effort` is fixed at spawn like `--model`, so a Session whose Chosen
   * Effort has moved needs a different process to serve its next Turn. Unlike
   * the model there is no `system/init` field to contradict a pool that got this
   * wrong: it would serve every Turn at the effort the process happened to start
   * at, report the level that was asked for, and record it — with no evidence
   * anywhere (ADR-0016).
   */
  it('starts a new process when the Session has been moved to another effort [fence:pool-every-term-is-compared]', async () => {
    const chosen = new Map<string, string>()
    const { log, send, claude } = newPool({
      efforts: { kind: 'effort', inForce: (sessionId) => chosen.get(sessionId) ?? 'high' },
    })
    await send(A, 'first', OK)

    chosen.set(A, 'max')
    await send(A, 'and again', OK)

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--effort') + 1], COMPARED).toBe('max')
    expect(log, COMPARED).toContainEqual({
      event: 'swap',
      sessionId: A,
      reason: 'effort',
      from: 'high',
      to: 'max',
    })
  })

  // The model wins where both moved, because it is the larger fact — and the
  // effort is on the `spawn` record that follows either way, which is the only
  // statement per process of what roma put in the arguments.
  it('names the model when the effort moved too, and leaves the effort to the spawn', async () => {
    const model = new Map<string, string>()
    const effort = new Map<string, string>()
    const { log, send } = newPool({
      models: { kind: 'model', inForce: (id) => model.get(id) ?? 'claude-sonnet-5' },
      efforts: { kind: 'effort', inForce: (id) => effort.get(id) ?? 'high' },
    })
    await send(A, 'first', OK)

    model.set(A, 'claude-opus-5')
    effort.set(A, 'max')
    await send(A, 'and again', OK)

    expect(log.filter(({ event }) => event === 'swap')).toEqual([
      {
        event: 'swap',
        sessionId: A,
        reason: 'model',
        from: 'claude-sonnet-5',
        to: 'claude-opus-5',
      },
    ])
    expect(log.filter(({ event }) => event === 'spawn').at(-1)).toMatchObject({
      model: 'claude-opus-5',
      effort: 'max',
    })
  })

  // A Session nobody has moved is one process for as long as the pool keeps it.
  // Asked because the comparison is made at every acquisition, and one that read
  // the record wrongly would present as a cold start on every message.
  it('keeps the process when the effort has not moved', async () => {
    const { log, send } = newPool({ efforts: { kind: 'effort', inForce: () => 'high' } })

    await send(A, 'first', OK)
    await send(A, 'and again', OK)

    expect(log.filter(({ event }) => event === 'swap')).toEqual([])
  })

  it('keeps the process when the model has not moved', async () => {
    const { log, send } = newPool({ models: { kind: 'model', inForce: () => 'claude-sonnet-5' } })

    await send(A, 'first', OK)
    await send(A, 'and again', OK)

    expect(log.filter(({ event }) => event === 'swap')).toEqual([])
  })

  /**
   * The fourth reason a process ends for money, and the one that moves a
   * different quantity from the other three.
   *
   * A credential change moves which bill a Turn lands on, a model change moves
   * what a token costs, an effort change moves how many the model spends
   * thinking — and this moves how many it spends *answering*. The ruleset rides
   * in `--append-system-prompt`, which is fixed at spawn like the other three,
   * so a Session whose Chosen Caveman has moved needs a different process.
   *
   * Named by the level rather than by the text: `from` and `to` are what an
   * operator can read, and the text is several thousand characters of somebody
   * else's prose (ADR-0030).
   */
  it('starts a new process when the Session has been moved to another Caveman [fence:pool-every-term-is-compared]', async () => {
    const chosen = new Map<string, string>()
    const { log, send, claude } = newPool({
      cavemen: { kind: 'caveman', inForce: (sessionId) => chosen.get(sessionId) ?? 'off' },
    })
    await send(A, 'first', OK)

    chosen.set(A, 'ultra')
    await send(A, 'and again', OK)

    const args = claude.lastSpawn.args
    expect(args[args.indexOf('--append-system-prompt') + 1], COMPARED).toBe(cavemanRuleset('ultra'))
    expect(log, COMPARED).toContainEqual({
      event: 'swap',
      sessionId: A,
      reason: 'caveman',
      from: 'off',
      to: 'ultra',
    })
  })

  // Asked because the comparison is made at every acquisition, and one that read
  // the record wrongly would present as a cold start on every message. Sharper
  // than the model's and the effort's: what is compared is a rendered paragraph
  // rather than a word, so a template that interpolated anything varying would
  // fail here rather than in production.
  it('keeps the process when the Caveman has not moved', async () => {
    const { log, send } = newPool({
      cavemen: { kind: 'caveman', inForce: () => 'full' },
      announcements: ['reaches a-team/roma'],
    })

    await send(A, 'first', OK)
    await send(A, 'and again', OK)

    expect(log.filter(({ event }) => event === 'swap')).toEqual([])
  })

  // The model still wins, and the Caveman is named ahead of the credential
  // because the credential is on the `spawn` record that follows and this is on
  // nothing else at all.
  it('names the Caveman when the credential moved too, and leaves the credential to the spawn', async () => {
    const chosen = new Map<string, string>()
    const { log, send } = newPool({
      cavemen: { kind: 'caveman', inForce: (sessionId) => chosen.get(sessionId) ?? 'off' },
    })
    await send(A, 'first', OK)

    chosen.set(A, 'lite')
    await send(A, 'and again', OK, 'overflow')

    expect(log.filter(({ event }) => event === 'swap')).toEqual([
      { event: 'swap', sessionId: A, reason: 'caveman', from: 'off', to: 'lite' },
    ])
    expect(log.filter(({ event }) => event === 'spawn').at(-1)).toMatchObject({
      credential: 'overflow',
      caveman: 'lite',
    })
  })

  // Both at once, which is what an Overflow retry on a Session somebody moved in
  // between looks like. One record rather than two, because it is one event —
  // the next Turn's terms are not the ones this process was started for — and
  // the model is what it names, because the credential is on the `spawn` that
  // follows and the model would otherwise appear nowhere. An operator reading
  // an unexplained respawn gets both halves; neither is silent.
  it('names the model when the credential moved too, and leaves the credential to the spawn', async () => {
    const chosen = new Map<string, string>()
    const { log, send } = newPool({
      models: { kind: 'model', inForce: (sessionId) => chosen.get(sessionId) ?? 'claude-sonnet-5' },
    })
    await send(A, 'first', OK)

    chosen.set(A, 'claude-opus-5')
    await send(A, 'and again', OK, 'overflow')

    expect(log.filter(({ event }) => event === 'swap')).toEqual([
      {
        event: 'swap',
        sessionId: A,
        reason: 'model',
        from: 'claude-sonnet-5',
        to: 'claude-opus-5',
      },
    ])
    expect(log.filter(({ event }) => event === 'spawn').at(-1)).toMatchObject({
      credential: 'overflow',
      model: 'claude-opus-5',
    })
  })
})

/**
 * The system-prompt append, assembled here because half of it is per Session.
 *
 * It was one text the composition root joined once and the pool read again at
 * every spawn, which made "per spawn" true and meaningless (#185). ADR-0030's
 * Chosen Caveman is what makes it mean something: the Reach announcements are
 * the deployment's and settled at boot, the ruleset is this Session's, and the
 * pool is the only thing that knows which Session is about to start.
 *
 * Asserted off the spawned process's own arguments, because everything between
 * the record and the argv is what could go wrong.
 */
describe('what a Session is told about itself', () => {
  /** What one Session was appended, or nothing where the flag was left off. */
  const appendedTo = (spawn: { args: readonly string[] }): string | undefined => {
    const at = spawn.args.indexOf('--append-system-prompt')
    return at === -1 ? undefined : spawn.args[at + 1]
  }

  it('joins the Reach announcements ahead of the ruleset, on a blank line [fence:pool-reaches-before-the-ruleset]', async () => {
    const why =
      'The append is every Reach announcement, then the Caveman ruleset, each part on its own ' +
      'paragraph (ADR-0030). What roma can reach is what the Session may do and how short to ' +
      'be is how it should answer; the second is only useful once the first is read, and an ' +
      'agent skimming a system prompt reads a break as a change of subject (#192).'
    const { claude, send } = newPool({
      announcements: ['reaches a-team/roma', 'acts as agent@a-project'],
      cavemen: { kind: 'caveman', inForce: () => 'lite' },
    })

    await send(A, 'hello', OK)

    expect(appendedTo(claude.lastSpawn), why).toBe(
      `reaches a-team/roma\n\nacts as agent@a-project\n\n${cavemanRuleset('lite')}`,
    )
  })

  // A Reach with nothing to say and an `off` Caveman are the same case, and both
  // are dropped before the join rather than trimmed after it. The empty part in
  // the middle is the one a trim cannot reach.
  it('drops an empty part rather than joining it and tidying up after [fence:pool-empty-parts-dropped-before-join]', async () => {
    const why =
      'Empty parts of the append are dropped before the join, never trimmed after it ' +
      '(ADR-0030). An unavailable Reach between two available ones, or an `off` Caveman, ' +
      'otherwise leaves extra blank lines on the argv of every Session in the deployment (#192).'
    const { claude, send } = newPool({
      announcements: ['reaches a-team/roma', '', 'acts as agent@a-project'],
      cavemen: { kind: 'caveman', inForce: () => 'off' },
    })

    await send(A, 'hello', OK)

    expect(appendedTo(claude.lastSpawn), why).toBe('reaches a-team/roma\n\nacts as agent@a-project')
  })

  // A `/caveman` can land between two readings of the record. One reading is
  // what keeps the argv's text and the level a swap names it by describing the
  // same record.
  it('renders the argv and names the level from one reading of the record [fence:pool-caveman-read-once]', async () => {
    const why =
      'The Caveman is resolved once per acquisition, and the append rendered from that one ' +
      'reading (ADR-0030). Read twice, a /caveman landing between the reads makes the argv ' +
      'text and the level the pool reports — to a swap and to the Audit Record — describe ' +
      'different records (#192).'
    const readings = ['lite', 'ultra']
    const { claude, pool, send } = newPool({
      cavemen: { kind: 'caveman', inForce: () => readings.shift() ?? 'off' },
    })

    await send(A, 'hello', OK)

    expect(pool.cavemanOn(A), why).toBe('lite')
    expect(appendedTo(claude.lastSpawn), why).toBe(cavemanRuleset('lite'))
  })

  // Two Sessions of one deployment, told two different things — which is the
  // whole of what a Chosen Caveman is and the thing a deployment-wide append
  // could not do.
  it('tells two Sessions of one deployment two different things', async () => {
    const chosen = new Map([[B, 'ultra']])
    const { claude, send } = newPool({
      announcements: ['reaches a-team/roma'],
      cavemen: { kind: 'caveman', inForce: (sessionId) => chosen.get(sessionId) ?? 'off' },
    })

    await send(A, 'hello', OK)
    const first = appendedTo(claude.lastSpawn)
    await send(B, 'hello', OK)

    expect(first).toBe('reaches a-team/roma')
    expect(appendedTo(claude.lastSpawn)).toBe(`reaches a-team/roma\n\n${cavemanRuleset('ultra')}`)
  })

  // Read at the spawn rather than handed over, which is what makes a Chosen
  // Caveman written while roma was somewhere else in force without anybody
  // telling the pool.
  it('passes the flag at all only where there is something to say [fence:pool-empty-append-is-absent]', async () => {
    const { claude, send } = newPool()

    await send(A, 'hello', OK)

    expect(
      claude.lastSpawn.args,
      'With nothing to append, the term is undefined and never an empty string: ' +
        '--append-system-prompt is gated on undefined (ADR-0030). An empty value reaches the ' +
        'argv of every Session in the deployment (#192).',
    ).not.toContain('--append-system-prompt')
  })

  // The Pinned Caveman, for a pool built without a per-Session answer — `model`
  // and `effort` have the same pair, and this is the third.
  it('falls back to one Caveman for the whole pool where nothing answers per Session', async () => {
    const { claude, send } = newPool({ caveman: 'full' })

    await send(A, 'hello', OK)

    expect(appendedTo(claude.lastSpawn)).toBe(cavemanRuleset('full'))
  })

  // What the Audit Record names a Task by (ADR-0030), and the reason the answer
  // is the process's rather than the record's: a Chosen Caveman written while
  // the Turn was running moves the next spawn, and a ledger that resolved it a
  // second time would name a level nothing was asked for.
  it('says what the process serving a Session was started at, not what is set now [fence:pool-caveman-is-what-the-process-ran-at]', async () => {
    const chosen = new Map([[A, 'lite']])
    const { pool, send } = newPool({
      cavemen: { kind: 'caveman', inForce: (sessionId) => chosen.get(sessionId) ?? 'off' },
    })

    await send(A, 'hello', OK)
    chosen.set(A, 'ultra')

    expect(
      pool.cavemanOn(A),
      'cavemanOn answers what the serving process was started at, never a fresh reading of ' +
        'the record (ADR-0030). A /caveman mid-Turn moves the next spawn; the Audit Record ' +
        'must name the level the Turn ran at, and the pool is the only place that exists (#192).',
    ).toBe('lite')
  })

  it('says nothing about a Session no process is serving', () => {
    const { pool } = newPool()

    expect(pool.cavemanOn(A)).toBeNull()
  })
})

describe('the ports the pool asks at every spawn', () => {
  // A type-level check: `npm run typecheck` fails here if the `kind` members
  // are dropped, because the swaps below would then compile.
  it('cannot be passed for one another [fence:pool-ports-are-distinct]', () => {
    const why =
      'SessionModels, SessionEfforts and SessionCavemen each carry a `kind` literal, so one ' +
      'cannot be passed where another goes (ADR-0016). Without it the ports are one ' +
      'structural type in adjacent options, and swapped, every process spawns with the ' +
      'effort as its model and nothing says so (#136).'
    const model: SessionModels = { kind: 'model', inForce: () => 'claude-opus-5' }
    const effort: SessionEfforts = { kind: 'effort', inForce: () => 'high' }
    const caveman: SessionCavemen = { kind: 'caveman', inForce: () => 'lite' }

    // @ts-expect-error -- an effort port where the model port goes is the swap this forbids
    const asModel: SessionModels = effort
    // @ts-expect-error -- and the other way round
    const asEffort: SessionEfforts = model
    // @ts-expect-error -- and the third port in the row
    const asCaveman: SessionCavemen = effort

    expect([asModel.kind, asEffort.kind, asCaveman.kind, caveman.kind], why).toEqual([
      'effort',
      'model',
      'effort',
      'caveman',
    ])
  })
})
