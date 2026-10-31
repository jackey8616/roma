import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ClaudeEvent } from '../../src/stream-events.js'
import type { FakeClaudeProcess } from './fake-claude.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/claude-stream/', import.meta.url))

export interface RecordedStream {
  readonly events: readonly ClaudeEvent[]
  turn(n: number): readonly ClaudeEvent[]
}

export function recordedStream(name: string): RecordedStream {
  const events = readFileSync(`${FIXTURES}${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const { _t, ...event } = JSON.parse(line) as Record<string, unknown>
      void _t
      return event as ClaudeEvent
    })

  const turns: ClaudeEvent[][] = [[]]
  for (const event of events) {
    turns.at(-1)?.push(event)
    if (event.type === 'result') turns.push([])
  }

  return {
    events,
    turn(n) {
      const turn = turns[n - 1]
      if (turn === undefined || turn.at(-1)?.type !== 'result') {
        throw new Error(`recorded stream "${name}" has no Turn ${n}`)
      }
      return turn
    },
  }
}

export function kindOf(event: ClaudeEvent): string {
  if (event.type === 'system') return `system/${String(event['subtype'])}`
  if (event.type !== 'stream_event') return event.type
  const inner = event['event'] as Record<string, unknown>
  const delta = inner['delta'] as Record<string, unknown> | undefined
  return `stream_event/${String(delta === undefined ? inner['type'] : delta['type'])}`
}

export function ofKind(events: readonly ClaudeEvent[], kind: string): ClaudeEvent[] {
  return events.filter((event) => kindOf(event) === kind)
}

export function upToFirst(events: readonly ClaudeEvent[], kind: string): ClaudeEvent[] {
  const at = events.findIndex((event) => kindOf(event) === kind)
  if (at === -1) throw new Error(`this recording has no ${kind} event`)
  return events.slice(0, at + 1)
}

export function apiRetries(name: string): ClaudeEvent[] {
  return recordedStream(name).events.filter(
    (event) => event.type === 'system' && event['subtype'] === 'api_retry',
  )
}

export function withTotalCostUsd(
  events: readonly ClaudeEvent[],
  totalCostUsd: number,
): ClaudeEvent[] {
  return events.map((event) =>
    event.type === 'result' ? { ...event, total_cost_usd: totalCostUsd } : event,
  )
}

export function withApiKeySource(
  events: readonly ClaudeEvent[],
  apiKeySource: string,
): ClaudeEvent[] {
  return events.map((event) =>
    kindOf(event) === 'system/init' ? { ...event, apiKeySource } : event,
  )
}

export function quotaEvent(info: Record<string, unknown> = {}): ClaudeEvent {
  const [event] = ofKind(recordedStream('three-turns-one-process').events, 'rate_limit_event')
  if (event === undefined) throw new Error('that capture has no rate_limit_event')
  return { ...event, rate_limit_info: { ...(event['rate_limit_info'] as object), ...info } }
}

export function withCompactionError(events: readonly ClaudeEvent[], code: string): ClaudeEvent[] {
  return events.map((event) =>
    event['compact_result'] === 'failed' ? { ...event, compact_error: code } : event,
  )
}

export function withoutCompactionTokens(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.map((event) => {
    if (event['subtype'] !== 'compact_boundary') return event
    const { pre_tokens, post_tokens, ...metadata } = (event['compact_metadata'] ?? {}) as Record<
      string,
      unknown
    >
    void pre_tokens
    void post_tokens
    return { ...event, compact_metadata: metadata }
  })
}

export function feed(
  proc: FakeClaudeProcess,
  events: readonly ClaudeEvent[],
  { chunkSize = Infinity }: { chunkSize?: number } = {},
): void {
  const ndjson = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  if (chunkSize === Infinity) {
    proc.emitStdout(ndjson)
    return
  }
  for (let i = 0; i < ndjson.length; i += chunkSize) {
    proc.emitStdout(ndjson.slice(i, i + chunkSize))
  }
}

export const THREE_TURNS = recordedStream('three-turns-one-process')

export const OK: readonly ClaudeEvent[] = THREE_TURNS.turn(1)

export const FAILED: readonly ClaudeEvent[] = recordedStream('auth-failure').turn(1)

export const FAILED_OUTRIGHT: readonly ClaudeEvent[] = FAILED.filter(
  (event) => kindOf(event) !== 'system/api_retry',
)

export const STRAY_KEY: readonly ClaudeEvent[] = upToFirst(FAILED, 'system/init')

export const RETRIES: readonly ClaudeEvent[] = apiRetries('auth-failure')

export const RESUME_LOST: readonly ClaudeEvent[] = recordedStream('resume-lost').turn(1)

export const BLOCKED: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'rejected' }),
  ...FAILED_OUTRIGHT,
]

export const BLOCKED_WITH_OVERAGE: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'rejected', overageStatus: 'allowed' }),
  ...FAILED_OUTRIGHT,
]

export const NEARLY_SPENT: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'allowed_warning', utilization: 0.82 }),
  ...FAILED_OUTRIGHT,
]

export const GENERATING: readonly ClaudeEvent[] = recordedStream(
  'generation-partial-messages',
).turn(1)

export const FREE_RELAY: readonly ClaudeEvent[] = recordedStream('readout-context').turn(1)

export const COMPACTED: readonly ClaudeEvent[] = recordedStream('compaction-auto').turn(4)

export const COMPACTION_FAILED: readonly ClaudeEvent[] = recordedStream('compaction-failed').turn(2)

export const COMPACTED_MANUALLY: readonly ClaudeEvent[] =
  recordedStream('manual-compaction').turn(4)

export const MANUAL_COMPACTION_REFUSED: readonly ClaudeEvent[] = recordedStream(
  'manual-compaction-too-few-groups',
).turn(2)

export function withResultText(events: readonly ClaudeEvent[], text: string): ClaudeEvent[] {
  return events.map((event) => (event.type === 'result' ? { ...event, result: text } : event))
}

export const EFFORT_ANSWERS = {
  at: (level: string): readonly ClaudeEvent[] =>
    withResultText(FREE_RELAY, `Current effort level: ${level}`),
  ultracode: (): readonly ClaudeEvent[] =>
    withResultText(
      FREE_RELAY,
      'Current effort level: ultracode (xhigh + dynamic workflow orchestration; ' +
        'this session only)',
    ),
  unpinned: (currently = 'high'): readonly ClaudeEvent[] =>
    withResultText(FREE_RELAY, `Effort level: auto (currently ${currently})`),
} as const
