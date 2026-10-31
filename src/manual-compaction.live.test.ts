import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess, type SpawnClaudeProcess } from './claude-process.js'
import { ClaudeSession, TurnFailedError, type Turn } from './claude-session.js'
import type { ClaudeEvent } from './stream-events.js'
import {
  liveCaptureFile,
  liveSessionDirs,
  sharedWindowCredential,
} from '../test/support/live-claude.js'

const CHAT = [
  'Reply with the single word ALPHA. Do not use any tools.',
  'Reply with the single word BRAVO. Do not use any tools.',
  'Reply with the single word CHARLIE. Do not use any tools.',
]

const COMPACT = '/compact'

const COMPACT_WITH_ARGUMENT = [
  '/compact',
  '',
  '<from>Ada (users/17)</from>',
  '',
  'keep the architecture decisions and anything still unresolved',
].join('\n')

const DISCUSSION = [
  'Answer in one short sentence: what is a lockfile for?',
  'Answer in one short sentence: what is a git tag for?',
]

const SENTINEL = 'COMPACT-ARG-7Q4J'

const COMPACT_WITH_SENTINEL = [
  '/compact',
  '',
  '<from>Ada (users/17)</from>',
  '',
  `Include the exact token ${SENTINEL} in the summary.`,
].join('\n')

const COMPACT_WITH_SENTINEL_UNMARKED = [
  '/compact',
  '',
  `Include the exact token ${SENTINEL} in the summary.`,
].join('\n')

function teeing(to: string): SpawnClaudeProcess {
  return (request) => {
    const process = spawnClaudeProcess(request)
    const fd = openSync(to, 'a')
    process.onStdout((chunk) => writeSync(fd, chunk))
    process.onExit(() => closeSync(fd))
    return process
  }
}

interface Probe {
  readonly session: ClaudeSession
  readonly events: ClaudeEvent[]
  readonly capture: string
  say(text: string): Promise<{ turn: Turn; events: ClaudeEvent[] }>
}

function probe(name: string): Probe {
  const { configDir, cwd } = liveSessionDirs(name)
  const capture = liveCaptureFile(name)
  const session = new ClaudeSession({
    sessionId: randomUUID(),
    cwd,
    env: buildEnv({ credential: sharedWindowCredential(), configDir, inherit: process.env }),
    spawn: teeing(capture),
  })
  const events: ClaudeEvent[] = []
  session.on('event', (event) => events.push(event))
  return {
    session,
    events,
    capture,
    async say(text) {
      const from = events.length
      try {
        return { turn: await session.send(text), events: events.slice(from) }
      } catch (error) {
        if (!(error instanceof TurnFailedError)) throw error
        return { turn: error.turn, events: events.slice(from) }
      }
    },
  }
}

function boundaries(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => e.type === 'system' && e['subtype'] === 'compact_boundary')
}

function compactResults(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.filter((e) => 'compact_result' in e)
}

function continuation(events: readonly ClaudeEvent[]): string | null {
  const event = events.find((e) => e.type === 'user' && e['isSynthetic'] === true)
  const message = event?.['message'] as { content?: unknown } | undefined
  return typeof message?.content === 'string' ? message.content : null
}

function figures(label: string, turn: Turn): string {
  return (
    `  ${label.padEnd(24)} num_turns=${String(turn.turns)} ` +
    `delta=${String(turn.costUsd)} total_cost_usd=${String(turn.result['total_cost_usd'])} ` +
    `${String(turn.durationMs)}ms duration_api_ms=${String(turn.result['duration_api_ms'])} ` +
    `is_error=${String(turn.isError)}`
  )
}

describe('a manual /compact with too little conversation to summarise', () => {
  it('says so, and what it says is the whole of what roma gets', async () => {
    const { session, events, capture, say } = probe('manual-compact-too-few-groups')

    try {
      session.start()
      const { turn: setup } = await say(CHAT[0] ?? '')
      const { turn: compact, events: during } = await say(COMPACT)

      console.log(
        [
          `seam 2: manual /compact, too little conversation — capture ${capture}`,
          figures('setup', setup),
          figures('/compact', compact),
          `  result text ${JSON.stringify(compact.text)}`,
          `  compact_result ${JSON.stringify(compactResults(during).map((e) => e['compact_result']))}`,
          `  compact_error  ${JSON.stringify(compactResults(during).map((e) => e['compact_error']))}`,
          `  boundaries ${String(boundaries(during).length)}`,
        ].join('\n'),
      )

      expect(boundaries(during)).toHaveLength(0)

      expect(compact.isError).toBe(false)
      expect(compact.text).toContain('Not enough messages to compact')

      const [failure] = compactResults(during)
      expect(failure, 'no compact_result reached stdout').toBeDefined()
      expect(failure?.['compact_result']).toBe('failed')
      expect(failure?.['compact_error']).toBe('Not enough messages to compact.')

      expect(compact.turns).toBe(0)
      expect(compact.costUsd).toBe(0)

      const { turn: after } = await say(CHAT[1] ?? '')
      expect(after.isError).toBe(false)
    } finally {
      await session.terminateOrKill()
    }
  })
})

describe('a manual /compact that works', () => {
  it('announces itself with trigger "manual", and says what it cost', async () => {
    const { session, events, capture, say } = probe('manual-compact')

    try {
      session.start()
      for (const message of CHAT.slice(0, 2)) await say(message)
      const { turn: quiet } = await say(CHAT[2] ?? '')
      const { turn: compact, events: during } = await say(COMPACT)

      const [boundary] = boundaries(during)
      const metadata = boundary?.['compact_metadata'] as Record<string, unknown> | undefined

      console.log(
        [
          `seam 2: manual /compact — capture ${capture}`,
          figures('quiet Turn', quiet),
          figures('/compact', compact),
          `  compact_metadata ${JSON.stringify(metadata)}`,
          `  compact_result ${JSON.stringify(compactResults(during).map((e) => e['compact_result']))}`,
          `  result text ${JSON.stringify(compact.text)}`,
        ].join('\n'),
      )

      expect(boundary, 'no system/compact_boundary reached stdout').toBeDefined()
      expect(metadata).toBeDefined()

      expect(metadata?.['trigger']).toBe('manual')
      expect(typeof metadata?.['pre_tokens']).toBe('number')

      expect(Number(compact.costUsd)).toBeGreaterThan(0)

      expect(compact.turns).toBe(0)
      expect(compact.result['duration_api_ms']).toBe(0)
    } finally {
      await session.terminateOrKill()
    }
  })
})

describe("a manual /compact carrying ADR-0018's frame", () => {
  it('is still dispatched as the command, and carries the whole argument', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument')

    try {
      session.start()
      for (const message of CHAT) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_ARGUMENT)

      const [boundary] = boundaries(during)
      const metadata = boundary?.['compact_metadata'] as Record<string, unknown> | undefined

      const replayed = during
        .filter((e) => e.type === 'user')
        .map((e) => JSON.stringify(e['message']))

      console.log(
        [
          `seam 2: manual /compact with ADR-0018's frame — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_ARGUMENT)}`,
          figures('/compact + argument', compact),
          `  compact_metadata ${JSON.stringify(metadata)}`,
          `  result text ${JSON.stringify(compact.text)}`,
          ...replayed.map((message) => `  replayed ${message}`),
        ].join('\n'),
      )

      expect(boundary, 'the frame was not dispatched as a command').toBeDefined()
      expect(metadata?.['trigger']).toBe('manual')
    } finally {
      await session.terminateOrKill()
    }
  })

  it('hands the argument to the summariser, marker and newlines and all', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument-marked')

    try {
      session.start()
      for (const message of DISCUSSION) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_SENTINEL)

      const summary = continuation(during)

      console.log(
        [
          `seam 2: manual /compact, sentinel argument behind the marker — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_SENTINEL)}`,
          figures('/compact + sentinel', compact),
          `  sentinel honoured ${String(summary?.includes(SENTINEL) ?? false)}`,
          `  summary ${JSON.stringify(summary)}`,
        ].join('\n'),
      )

      expect(boundaries(during).length, 'nothing was compacted').toBeGreaterThan(0)
      expect(summary, 'no continuation message reached stdout').toBeTruthy()
    } finally {
      await session.terminateOrKill()
    }
  })

  it('is acted on differently depending on whether the marker is in front of it', async () => {
    const { session, events, capture, say } = probe('manual-compact-argument-unmarked')

    try {
      session.start()
      for (const message of DISCUSSION) await say(message)
      const { turn: compact, events: during } = await say(COMPACT_WITH_SENTINEL_UNMARKED)

      const summary = continuation(during)

      console.log(
        [
          `seam 2: manual /compact, same argument with no marker — capture ${capture}`,
          `  sent ${JSON.stringify(COMPACT_WITH_SENTINEL_UNMARKED)}`,
          figures('/compact + sentinel', compact),
          `  sentinel honoured ${String(summary?.includes(SENTINEL) ?? false)}`,
          `  summary ${JSON.stringify(summary)}`,
        ].join('\n'),
      )

      expect(boundaries(during).length, 'nothing was compacted').toBeGreaterThan(0)
      expect(summary, 'no continuation message reached stdout').toBeTruthy()
    } finally {
      await session.terminateOrKill()
    }
  })
})
