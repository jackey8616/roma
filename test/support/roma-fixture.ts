import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionIdFor } from '../../src/session-id.js'
import type { ClaudeEvent } from '../../src/stream-events.js'
import { FakeClaude, flush, type FakeClaudeProcess } from './fake-claude.js'
import { feed, recordedStream } from './recorded-stream.js'

/** One complete Turn of a real recorded stream. Its text is "ok". */
const OK = recordedStream('three-turns-one-process').turn(1)

/** The three directories a whole roma is given, in the shape it takes them. */
export interface RomaDirectories {
  readonly workRoot: string
  readonly auditRoot: string
  readonly configDir: string
}

export interface RomaFixture {
  readonly claude: FakeClaude
  /** Spread straight into the options of whatever entry point is under test. */
  readonly dirs: RomaDirectories
  /** The same three, as the teardown wants them. */
  readonly roots: readonly string[]
  /**
   * The process serving one Conversation's Session.
   *
   * Which directory that is — `workRoot` joined with the Session id the
   * Conversation Key derives to — is roma's own rule, and a test that spelled it
   * out would be asserting it in passing every time it wanted to feed a Turn.
   */
  procFor(conversationKey: string): FakeClaudeProcess
  /**
   * Answer the self-check's probe Turn, the way a real process would.
   *
   * Every entry point that boots a whole roma drives one before it will do
   * anything else, so every test of one has to answer it before it can get to
   * what it is actually about.
   */
  answerProbe(events?: readonly ClaudeEvent[]): Promise<void>
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
 * behind says which file it came from.
 */
export function romaFixture(name: string): RomaFixture {
  const claude = new FakeClaude({ exitOnKill: true })
  const workRoot = mkdtempSync(join(tmpdir(), `roma-${name}-`))
  const auditRoot = mkdtempSync(join(tmpdir(), `roma-${name}-audit-`))
  const configDir = mkdtempSync(join(tmpdir(), `roma-${name}-claude-`))

  return {
    claude,
    dirs: { workRoot, auditRoot, configDir },
    roots: [workRoot, auditRoot, configDir],
    procFor: (conversationKey) => claude.processFor(join(workRoot, sessionIdFor(conversationKey))),
    answerProbe: async (events = OK) => {
      await flush()
      feed(claude.process, events)
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
