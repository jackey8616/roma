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
 * How these captures name one event: its type, plus whichever sub-name the
 * stream uses for it — `system/task_started`, `stream_event/text_delta`.
 *
 * Deliberately its own reading of the stream rather than the one in
 * `src/stream-events.ts`. A test that located its fixtures with the code under
 * test would agree with it about the field paths by construction, and the field
 * paths are most of what there is to get wrong.
 */
export function kindOf(event: ClaudeEvent): string {
  if (event.type === 'system') return `system/${String(event['subtype'])}`
  if (event.type !== 'stream_event') return event.type
  const inner = event['event'] as Record<string, unknown>
  const delta = inner['delta'] as Record<string, unknown> | undefined
  return `stream_event/${String(delta === undefined ? inner['type'] : delta['type'])}`
}

/** The events of one kind, in the order they arrived. */
export function ofKind(events: readonly ClaudeEvent[], kind: string): ClaudeEvent[] {
  return events.filter((event) => kindOf(event) === kind)
}

/**
 * A recorded Turn cut off after the first event of one kind.
 *
 * How a test stops a stream part-way — at `system/task_started`, say, which is
 * where 25339ms of complete silence began in the tool capture.
 */
export function upToFirst(events: readonly ClaudeEvent[], kind: string): ClaudeEvent[] {
  const at = events.findIndex((event) => kindOf(event) === kind)
  if (at === -1) throw new Error(`this recording has no ${kind} event`)
  return events.slice(0, at + 1)
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
 * The same recorded Turn with a different `apiKeySource` on its `system/init`.
 *
 * For the pairing no capture holds: a Turn that succeeds while reporting that a
 * key, rather than the subscription, is paying for it. Both values are real —
 * `auth-failure` was captured under `ANTHROPIC_API_KEY` and every other capture
 * under the OAuth token — but the one run under the key also failed on it, so
 * the healthy-and-billed-elsewhere case has to be built out of the two.
 */
export function withApiKeySource(
  events: readonly ClaudeEvent[],
  apiKeySource: string,
): ClaudeEvent[] {
  return events.map((event) =>
    kindOf(event) === 'system/init' ? { ...event, apiKeySource } : event,
  )
}

/**
 * A real `rate_limit_event`, with whichever fields a test needs changed.
 *
 * For the one case no capture can hold: a spent Shared Window. Every recording
 * here says `status: "allowed"`, and recording the other case means deliberately
 * draining the window the whole team shares, which blocks everybody — the
 * token's owner included — until it resets.
 *
 * So the event is real, its `resetsAt` is the real one, and the field under test
 * is the only thing changed. That keeps the guess in one place: `spentUntil` in
 * `src/quota.ts` is where roma says what it believes a spent window looks like,
 * and this is where a test says the same thing.
 */
export function quotaEvent(info: Record<string, unknown> = {}): ClaudeEvent {
  const [event] = ofKind(recordedStream('three-turns-one-process').events, 'rate_limit_event')
  if (event === undefined) throw new Error('that capture has no rate_limit_event')
  return { ...event, rate_limit_info: { ...(event['rate_limit_info'] as object), ...info } }
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

// The Turns the tests share, derived here rather than in each of them.
//
// Every one of these was being cut out of the same two captures in three or four
// files at once, and they had already come apart: `STRAY_KEY` meant the whole
// 401 Turn in one file and the same Turn cut short in two others, so a test
// reading one file's name got the other file's events. Both of those Turns are
// wanted, they are just not the same Turn, and naming them once is what keeps
// that true.

/** The capture of one process serving three Turns, for whichever one is wanted. */
export const THREE_TURNS = recordedStream('three-turns-one-process')

/**
 * One complete Turn under the Shared Window credential. Its text is "ok".
 *
 * `apiKeySource: "none"`, `model: "claude-sonnet-5"`, `is_error: false` — what a
 * boot that should be allowed to proceed looks like, and what a Task that worked
 * looks like everywhere else.
 */
export const OK: readonly ClaudeEvent[] = THREE_TURNS.turn(1)

/**
 * The whole Turn run under a stray `ANTHROPIC_API_KEY`, as captured.
 *
 * `apiKeySource: "ANTHROPIC_API_KEY"`, a model silently moved to
 * `claude-opus-5[1m]`, ten `api_retry` events spread over 182 seconds, and a 401
 * arriving as `is_error: true` with `subtype: "success"`.
 */
export const FAILED: readonly ClaudeEvent[] = recordedStream('auth-failure').turn(1)

/**
 * The same 401 with its retry storm taken out, so the Turn fails on its own.
 *
 * The capture holds more `api_retry` events than the retry budget allows — fed
 * whole, it is a Task roma abandons rather than one Claude Code failed, and
 * those are different endings with different costs.
 */
export const FAILED_OUTRIGHT: readonly ClaudeEvent[] = FAILED.filter(
  (event) => kindOf(event) !== 'system/api_retry',
)

/**
 * The same Turn cut off after the `system/init` that reports the stray key.
 *
 * The shortest stream that fails the startup self-check: `apiKeySource` is
 * settled before the first API call, so nothing after it changes the answer.
 */
export const STRAY_KEY: readonly ClaudeEvent[] = upToFirst(FAILED, 'system/init')

/**
 * The ten real `api_retry` events a bad credential produced — the ones the
 * retry-storm cap exists for, 401 `authentication_failed` and all.
 */
export const RETRIES: readonly ClaudeEvent[] = apiRetries('auth-failure')

/**
 * A Turn that failed with the Shared Window reported spent.
 *
 * Built rather than captured: every recording roma holds says `status:
 * "allowed"`, and the only way to record the other case is to drain the window
 * everybody shares. `spentUntil` in `src/quota.ts` is where that guess lives.
 */
export const BLOCKED: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'blocked' }),
  ...FAILED_OUTRIGHT,
]

/** The same, with the provider willing to sell overage. */
export const BLOCKED_WITH_OVERAGE: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'blocked', overageStatus: 'allowed' }),
  ...FAILED_OUTRIGHT,
]

/** The 72-second generating Turn: 194 `text_delta` events and no tool at all. */
export const GENERATING: readonly ClaudeEvent[] = recordedStream(
  'generation-partial-messages',
).turn(1)
