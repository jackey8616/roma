import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PINNED_EFFORT } from '../../src/claude-session.js'
import { sessionIdFor } from '../../src/session-id.js'
import type { ClaudeEvent } from '../../src/stream-events.js'
import { FakeClaude, flush, type FakeClaudeProcess } from './fake-claude.js'
import { EFFORT_ANSWERS, feed, OK } from './recorded-stream.js'

export interface RomaDirectories {
  readonly workRoot: string
  readonly auditRoot: string
  readonly configDir: string
}

export interface RomaFixture {
  readonly claude: FakeClaude
  readonly dirs: RomaDirectories
  readonly roots: readonly string[]
  alsoRemove(root: string): void
  procFor(conversationKey: string): FakeClaudeProcess
  procIn(sessionId: string): FakeClaudeProcess
  answerProbe(events?: readonly ClaudeEvent[], effort?: readonly ClaudeEvent[]): Promise<void>
}

export function romaFixture(
  name: string,
  { workRoot = mkdtempSync(join(tmpdir(), `roma-${name}-`)) }: { workRoot?: string } = {},
): RomaFixture {
  const claude = new FakeClaude({ exitOnKill: true })
  const auditRoot = mkdtempSync(join(tmpdir(), `roma-${name}-audit-`))
  const configDir = mkdtempSync(join(tmpdir(), `roma-${name}-claude-`))
  const procIn = (sessionId: string) => claude.processFor(join(workRoot, sessionId))
  const roots = [workRoot, auditRoot, configDir]

  return {
    claude,
    dirs: { workRoot, auditRoot, configDir },
    roots,
    alsoRemove: (root) => {
      roots.push(root)
    },
    procIn,
    procFor: (conversationKey) => procIn(sessionIdFor(conversationKey)),
    answerProbe: async (events = OK, effort = EFFORT_ANSWERS.at(PINNED_EFFORT)) => {
      await flush()
      feed(claude.process, events)
      await flush()
      feed(claude.process, effort)
    },
  }
}

export async function teardownRoma(
  closables: readonly { shutdown(): Promise<void> }[],
  roots: readonly string[],
): Promise<void> {
  for (const closable of closables) await closable.shutdown().catch(() => {})
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
