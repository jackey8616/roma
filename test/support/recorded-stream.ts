import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ClaudeEvent } from '../../src/stream-events.js'
import type { FakeClaudeProcess } from './fake-claude.js'

const FIXTURES = fileURLToPath(new URL('../fixtures/claude-stream/', import.meta.url))

export interface RecordedStream {
  readonly events: readonly ClaudeEvent[]
  /**
   * The events of one Turn, 1-based, up to and including its terminal `result`.
   * Turn boundaries are the `result` events themselves.
   */
  turn(n: number): readonly ClaudeEvent[]
}

/**
 * Load a capture of a real `claude -p` stream.
 *
 * These are recordings, not hand-written doubles: every one was produced by the
 * prototype against Claude Code v2.1.220 and costs real money to reproduce. See
 * `test/fixtures/claude-stream/README.md` for what each one caught.
 */
export function recordedStream(name: string): RecordedStream {
  const events = readFileSync(`${FIXTURES}${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      // `_t` is the prototype's own arrival timestamp, not part of the stream.
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

/**
 * The `api_retry` events of a recorded stream, in the order they arrived.
 *
 * `auth-failure` holds ten of them, spread over 182 seconds under a bad
 * credential — the real storm the retry budget exists to cut short, carrying the
 * real 401. Slice as many as a test needs to spend a budget.
 */
export function apiRetries(name: string): ClaudeEvent[] {
  return recordedStream(name).events.filter(
    (event) => event.type === 'system' && event['subtype'] === 'api_retry',
  )
}

/**
 * The same recorded Turn with a different `total_cost_usd` on its terminal event.
 *
 * For the one thing no single recording can supply: what a `--resume`d process
 * reports. Seam 2 measured that it counts from zero rather than continuing the
 * Session total, and this is how that second process's stream is built out of a
 * real Turn rather than hand-written.
 */
export function withTotalCostUsd(
  events: readonly ClaudeEvent[],
  totalCostUsd: number,
): ClaudeEvent[] {
  return events.map((event) =>
    event.type === 'result' ? { ...event, total_cost_usd: totalCostUsd } : event,
  )
}

/**
 * Push events at a fake process as NDJSON bytes.
 *
 * `chunkSize` decides where the chunk boundaries fall. The default sends each
 * whole stream in one go; a small size splits lines apart, which is what the OS
 * does to a real stdout at unpredictable moments.
 */
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
