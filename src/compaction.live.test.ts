import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession, type Turn } from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

const PCT_OVERRIDE = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'

const BASELINE_TOKENS = 29_900

const ROOM_TO_GROW = '4'

const BELOW_THE_FLOOR = '1'

function filler(): string {
  const words = [
    'ledger',
    'window',
    'session',
    'compaction',
    'threshold',
    'operator',
    'caller',
    'audit',
    'transcript',
    'generation',
    'enclosure',
    'relay',
  ]
  return Array.from({ length: 900 }, (_, i) => {
    const line = Array.from({ length: 10 }, (_, j) => words[(i * 7 + j * 3) % words.length])
    return `filler-${String(i).padStart(4, '0')}: ${line.join(' ')}`
  }).join('\n')
}

const OK = 'Reply with the single word OK. Do not use any tools.'

interface Probe {
  readonly session: ClaudeSession
  readonly events: ClaudeEvent[]
  say(text: string): Promise<{ turn: Turn; events: ClaudeEvent[] }>
}

function probe(name: string, pct: string): Probe {
  const { configDir, cwd } = liveSessionDirs(name)
  const session = new ClaudeSession({
    sessionId: randomUUID(),
    cwd,
    env: {
      ...buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
      [PCT_OVERRIDE]: pct,
    },
  })
  const events: ClaudeEvent[] = []
  session.on('event', (event) => events.push(event))
  return {
    session,
    events,
    async say(text) {
      const from = events.length
      const turn = await session.send(text)
      return { turn, events: events.slice(from) }
    },
  }
}

function boundaries(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => e.type === 'system' && e['subtype'] === 'compact_boundary')
}

function compactResults(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => 'compact_result' in e)
}

describe('a Compaction on the Session stdout roma reads', () => {
  it('announces itself, with what it cost and what it dropped', async () => {
    const { session, events, say } = probe('compaction', ROOM_TO_GROW)

    try {
      session.start()

      const { turn: before } = await say('/context')
      expect(before.turns).toBe(0)

      await say(`${filler()}\n\n${OK}`)
      const pair = [await say(OK), await say(OK)]

      const [boundary] = boundaries(events)
      expect(boundary, 'no system/compact_boundary reached stdout').toBeDefined()

      const metadata = boundary?.['compact_metadata'] as Record<string, unknown>
      expect(metadata).toBeDefined()
      expect(metadata['trigger']).toBe('auto')
      expect(typeof metadata['pre_tokens']).toBe('number')
      expect(Number(metadata['pre_tokens'])).toBeGreaterThan(BASELINE_TOKENS)

      const carrying = pair.find((sent) => boundaries(sent.events).length > 0)
      const quiet = pair.find((sent) => boundaries(sent.events).length === 0)
      expect(carrying, 'the Compaction landed outside the identical pair').toBeDefined()
      expect(quiet, 'both of the identical pair carried a Compaction').toBeDefined()

      expect(Number(carrying?.turn.turns)).toBeGreaterThan(Number(quiet?.turn.turns))
      expect(Number(carrying?.turn.costUsd)).toBeGreaterThan(Number(quiet?.turn.costUsd))

      console.log(
        `seam 2: compact_boundary on stdout — ${JSON.stringify(metadata)}; ` +
          `of two identical messages the quiet one cost ${String(quiet?.turn.costUsd)} ` +
          `over ${String(quiet?.turn.turns)} turn(s) in ${String(quiet?.turn.durationMs)}ms, ` +
          `the one carrying the Compaction ${String(carrying?.turn.costUsd)} over ` +
          `${String(carrying?.turn.turns)} in ${String(carrying?.turn.durationMs)}ms`,
      )
    } finally {
      await session.terminateOrKill()
    }
  })

  it('says so on the same stdout when it fails', async () => {
    const { session, events, say } = probe('compaction-failed', BELOW_THE_FLOOR)

    try {
      session.start()
      await say(OK)
      const { turn: after } = await say(OK)

      const [failure] = compactResults(events).filter((e) => e['compact_result'] === 'failed')
      expect(failure, 'no compact_result reached stdout').toBeDefined()
      expect(failure?.['compact_result']).toBe('failed')

      expect(typeof failure?.['compact_error']).toBe('string')

      expect(after.isError).toBe(false)

      console.log(
        `seam 2: compact_result=${String(failure?.['compact_result'])} ` +
          `compact_error=${String(failure?.['compact_error'])} ` +
          `on ${String(failure?.type)}/${String(failure?.['subtype'])}; ` +
          `the Session then served a Turn at ${String(after.costUsd)}`,
      )
    } finally {
      await session.terminateOrKill()
    }
  })
})
