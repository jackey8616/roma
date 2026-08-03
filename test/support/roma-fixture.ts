import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PINNED_EFFORT } from '../../src/claude-session.js'
import { sessionIdFor } from '../../src/session-id.js'
import type { ClaudeEvent } from '../../src/stream-events.js'
import { FakeClaude, flush, type FakeClaudeProcess } from './fake-claude.js'
import { EFFORT_ANSWERS, feed, OK } from './recorded-stream.js'

/** The three directories a whole roma is given, in the shape it takes them. */
export interface RomaDirectories {
  readonly workRoot: string
  readonly auditRoot: string
  readonly configDir: string
}

export interface RomaFixture {
  readonly claude: FakeClaude
  /**
   * Spread straight into the options of whatever entry point is under test.
   *
   * All three, always. A bare Core is given two of them and never asks for a
   * `configDir` — the spare costs one `mkdtemp` and is deleted with the rest,
   * which is cheaper than a fixture that has to be told which shape it is.
   */
  readonly dirs: RomaDirectories
  /** Everything this roma owns on disk, as the teardown wants it. */
  readonly roots: readonly string[]
  /**
   * Hand the teardown a directory this roma owns that the fixture did not make.
   *
   * For the parts a test assembles for itself. `fakeShims`'s socket directory
   * is the one there is: a throwaway of its own, made where the test decides
   * what minting is, and gone when the rest of the roma goes.
   */
  alsoRemove(root: string): void
  /**
   * The process serving one Conversation's Session.
   *
   * Which directory that is — `workRoot` joined with the Session id the
   * Conversation Key derives to — is roma's own rule, and a test that spelled it
   * out would be asserting it in passing every time it wanted to feed a Turn.
   */
  procFor(conversationKey: string): FakeClaudeProcess
  /**
   * The same process, waited for rather than demanded.
   *
   * Almost every test spawns within one `flush`, because nothing stands between
   * the message arriving and the Turn. An Enclosure does: it is redeemed and
   * written into the Working Directory first (ADR-0011), and that is real
   * filesystem work rather than a microtask.
   *
   * Waited out in elapsed time rather than by counting `flush`es, because a
   * count of event-loop turns is not a duration — on a loaded machine the turns
   * run out before the write lands, which is a test that passes alone and fails
   * in the suite.
   */
  spawnedFor(conversationKey: string): Promise<FakeClaudeProcess>
  /**
   * The process serving one named Session.
   *
   * For the tests that mean a particular Session rather than whichever one a
   * Conversation is on — after `/clear`, when the interesting thing is that the
   * next Turn runs somewhere else.
   */
  procIn(sessionId: string): FakeClaudeProcess
  /**
   * Answer the self-check's probe Turn and its effort relay, the way a real
   * process would.
   *
   * Every entry point that boots a whole roma drives one before it will do
   * anything else, so every test of one has to answer it before it can get to
   * what it is actually about.
   *
   * Two answers rather than one, because the check is two exchanges with one
   * process: the probe Turn that carries every blocking assertion, and then a
   * relayed `/effort current` that blocks nothing. `effort` defaults to agreeing
   * with the Pinned Effort — a boot that disagreed would still boot, and every
   * test that is about something else would gain an unexplained line in its
   * Operator Log.
   */
  answerProbe(events?: readonly ClaudeEvent[], effort?: readonly ClaudeEvent[]): Promise<void>
}

/**
 * Everything a test needs on hand before it can boot a whole roma.
 *
 * What it holds is the substrate the entry points share — a fake `claude`, the
 * directories they are given, and the probe Turn they all begin with — and
 * deliberately not the booting itself: `serve` and `startRoma` are told different
 * things and are awaited at different moments, and a fixture that boots for them
 * would have to take both apart again.
 *
 * `name` goes into the temporary directory names, so a test that leaves one
 * behind says which file it came from. `workRoot` is for the one thing a fresh
 * set of directories cannot express: a second roma coming up over the first
 * one's work root, which is how a restart is written down.
 */
export function romaFixture(
  name: string,
  { workRoot = mkdtempSync(join(tmpdir(), `roma-${name}-`)) }: { workRoot?: string } = {},
): RomaFixture {
  const claude = new FakeClaude({ exitOnKill: true })
  const auditRoot = mkdtempSync(join(tmpdir(), `roma-${name}-audit-`))
  const configDir = mkdtempSync(join(tmpdir(), `roma-${name}-claude-`))
  const procIn = (sessionId: string) => claude.processFor(join(workRoot, sessionId))
  const procFor = (conversationKey: string) => procIn(sessionIdFor(conversationKey))
  const roots = [workRoot, auditRoot, configDir]

  return {
    claude,
    dirs: { workRoot, auditRoot, configDir },
    roots,
    alsoRemove: (root) => {
      roots.push(root)
    },
    procIn,
    procFor,
    spawnedFor: async (conversationKey) => {
      for (let waited = 0; waited < 5_000; waited += 5) {
        await flush()
        try {
          return procFor(conversationKey)
        } catch {
          // `node:timers/promises` rather than the global, because a test that
          // fakes timers still has to wait here in real time.
          await sleep(5)
        }
      }
      throw new Error(`nothing was spawned for ${conversationKey}`)
    },
    answerProbe: async (events = OK, effort = EFFORT_ANSWERS.at(PINNED_EFFORT)) => {
      await flush()
      feed(claude.process, events)
      // Fed after the first, the way a real process answers: the relay is not
      // sent until the probe Turn has completed, so there is nothing listening
      // for this until then.
      await flush()
      feed(claude.process, effort)
    },
  }
}

/**
 * End everything a test started, then delete what it wrote.
 *
 * In that order, and the order is the point: a root deleted while its Resident
 * Sessions are still running is a `claude` process writing into a directory that
 * is no longer there. Having one function own both halves is what keeps the
 * order from being something each `afterEach` gets right on its own.
 *
 * Shutting down is tolerant because a test is allowed to have broken it on
 * purpose — one below makes closing the queue fail, and a second shutdown fails
 * the same way. The deleting still has to happen.
 */
export async function teardownRoma(
  closables: readonly { shutdown(): Promise<void> }[],
  roots: readonly string[],
): Promise<void> {
  for (const closable of closables) await closable.shutdown().catch(() => {})
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
