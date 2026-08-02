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
 * The same recorded Turn with a different code on its failed Compaction.
 *
 * `quotaEvent`'s discipline for the other measurement roma cannot afford to
 * take: `exhausted` means a context that genuinely cannot be reduced below the
 * limit, and provoking one means filling a real context — the expensive path
 * #98's whole measurement was designed to avoid. So the `system/status` event is
 * the real one, its `compact_result: "failed"` is real, and the code is the only
 * thing changed.
 *
 * What that leaves unproven is stated rather than hidden: the codes come off one
 * switch in the pinned build (#98's second comment quotes it whole), and that
 * `exhausted` reaches `compact_error` with that spelling on the *auto* path is
 * read rather than measured. What is measured is that a code survives the trip
 * unchanged, which is what `too_few_groups` did.
 */
export function withCompactionError(
  events: readonly ClaudeEvent[],
  code: string,
): ClaudeEvent[] {
  return events.map((event) =>
    event['compact_result'] === 'failed' ? { ...event, compact_error: code } : event,
  )
}

/**
 * The same recorded Compaction with its token figures taken off.
 *
 * `Compaction`'s fields are nullable everywhere in roma — a boundary that
 * carried none is a fact rather than a zero — and no capture roma holds is
 * missing them, so this is the only way to reach the branch that answers
 * without numbers. `withCompactionError`'s discipline exactly: a real stream,
 * with the one field under test changed.
 */
export function withoutCompactionTokens(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  return events.map((event) => {
    if (event['subtype'] !== 'compact_boundary') return event
    const { pre_tokens, post_tokens, ...metadata } = (event['compact_metadata'] ??
      {}) as Record<string, unknown>
    void pre_tokens
    void post_tokens
    return { ...event, compact_metadata: metadata }
  })
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
 * What `--resume` at a Session with no Transcript answers with, on stdout.
 *
 * A whole "Turn" in one event: `error_during_execution`, `is_error: true`,
 * `num_turns: 0`, `total_cost_usd: 0`, and the reason in an `errors` array. There
 * is no `result` field beside it, so the Turn roma builds from it has empty text.
 *
 * That pairing is the whole discriminator, and `TranscriptNotFound` is what reads
 * it: a Turn that genuinely failed carries the opposite — its sentence in
 * `result` and no `errors` at all, which is what `auth-failure` holds. Until
 * #105 nothing read `errors`, so this arrived as a generic failed Turn with
 * nothing to say, and `reasonFor` fell past every failure it can name.
 *
 * The half of this refusal the plain-`-p` measurements never saw. Both
 * `claude-session.live.test.ts` and `docs/transcript-collision-verification.md`
 * ran `claude -p`, where it is a line on stderr and an empty stdout.
 */
export const RESUME_LOST: readonly ClaudeEvent[] = recordedStream('resume-lost').turn(1)

/**
 * A Turn that failed with the Shared Window reported spent.
 *
 * Built rather than captured: every recording roma holds says `status:
 * "allowed"`, and the only way to record the other case is to drain the window
 * everybody shares.
 *
 * `"rejected"` because that is what the provider sends. These constants said
 * `"blocked"` for as long as they existed, which is a string Claude Code has
 * never emitted — and because `spentUntil` read "anything that is not allowed"
 * as spent, the invented value and the code agreed perfectly about a case
 * neither had seen, while the case that really arrives (`"allowed_warning"`,
 * meaning nearly spent and still serving) was read as an outage. A made-up
 * fixture value is not a neutral placeholder: it is a second wrong belief that
 * makes the first one look tested.
 */
export const BLOCKED: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'rejected' }),
  ...FAILED_OUTRIGHT,
]

/** The same, with the provider willing to sell overage. */
export const BLOCKED_WITH_OVERAGE: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'rejected', overageStatus: 'allowed' }),
  ...FAILED_OUTRIGHT,
]

/**
 * A Turn that failed while the Shared Window was merely *close* to spent.
 *
 * The pairing the `allowed_warning` bug needed and nothing exercised: the
 * window is still serving, and the Turn failed for its own reasons. Read as an
 * outage — which is what "anything that is not allowed is spent" did — the
 * Caller is told the shared quota is gone and given a reset time, and the 401
 * that actually happened is never mentioned to anybody.
 *
 * `utilization` is on it because Claude Code only sends that field once a
 * threshold has been crossed, so a real `allowed_warning` event carries one.
 */
export const NEARLY_SPENT: readonly ClaudeEvent[] = [
  quotaEvent({ status: 'allowed_warning', utilization: 0.82 }),
  ...FAILED_OUTRIGHT,
]

/** The 72-second generating Turn: 194 `text_delta` events and no tool at all. */
export const GENERATING: readonly ClaudeEvent[] = recordedStream(
  'generation-partial-messages',
).turn(1)

/**
 * The `/context` Relay, exactly as captured: `num_turns: 0`,
 * `total_cost_usd: 0`, `modelUsage: {}`, the command's own output as `result`.
 *
 * Named here because it is the only recording of a *free* relayed command roma
 * holds, and it is the right base for any other one. The file keeps the name it
 * was captured under, before ADR-0018 retired the word.
 */
export const FREE_RELAY: readonly ClaudeEvent[] = recordedStream('readout-context').turn(1)

/**
 * The Turn an auto-Compaction happened inside, exactly as captured.
 *
 * `system/status` going `compacting` then `success`, then the
 * `system/compact_boundary` itself — `trigger: "auto"`, 61486 tokens in and 1375
 * out over 19487ms — and `num_turns: 2` on the terminal event, because the
 * Compaction is a Turn of its own inside the one somebody sent.
 *
 * The money is the point: the Turn before it in the same capture is a
 * byte-identical message that cost $0.0186, and this one cost $0.0917. What both
 * of them say on an Audit Record is what #98 is about.
 */
export const COMPACTED: readonly ClaudeEvent[] = recordedStream('compaction-auto').turn(4)

/**
 * A Turn a Compaction was attempted inside and did not happen — `too_few_groups`.
 *
 * The capture that corrected the issue this was built for. #98 was written
 * believing a failed Compaction meant a Session that could not serve another
 * Turn; this one stayed healthy, answered, and its Session served the next Turn
 * normally at $0.0104. `withCompactionError` is how a test reaches the codes that
 * mean the other thing.
 */
export const COMPACTION_FAILED: readonly ClaudeEvent[] = recordedStream(
  'compaction-failed',
).turn(2)

/**
 * A `/compact` somebody asked for, exactly as captured — ADR-0018's paid Relay.
 *
 * The same `system/status` sequence and the same `system/compact_boundary` as the
 * auto path, differing in one field: `trigger: "manual"`. One reader serves both,
 * which is the finding that let this be built without inventing anything.
 *
 * The terminal event is where it stops resembling a Task. **`num_turns: 0`**,
 * `duration_api_ms: 0`, the top-level `usage` all zeros, and `result: ""` — while
 * `total_cost_usd` moved by $0.0453 over 28,545ms and `modelUsage` moved by
 * +1,978 output tokens. Two decisions rest on that pair: the drift check reads
 * `modelUsage` because nothing else can see this, and roma writes the reply
 * because Claude Code sends none.
 */
export const COMPACTED_MANUALLY: readonly ClaudeEvent[] = recordedStream(
  'manual-compaction',
).turn(4)

/**
 * A `/compact` on a thread with too little in it to summarise, exactly as
 * captured.
 *
 * On the evidence the commonest failure of the manual path there is, because
 * typing `/compact` into a short thread is exactly this. Free, instant — 29ms,
 * `num_turns: 0`, no cost — `is_error: false`, and Claude Code writes the
 * Caller's sentence itself, in both `compact_error` and the terminal `result`.
 *
 * **`compact_error` here is a sentence and not a code**, which is the seam
 * ADR-0018 left for the implementation: `compaction.ts` classifies by code, so
 * this would sort into `unexplained` and write an operator line about a Turn that
 * was fine. What closes it is that roma knows whose Compaction this is.
 */
export const MANUAL_COMPACTION_REFUSED: readonly ClaudeEvent[] = recordedStream(
  'manual-compaction-too-few-groups',
).turn(2)

/**
 * The same recorded Turn saying something else.
 *
 * For the case no capture can hold without spending the Shared Window again: an
 * `/effort current` answer. ADR-0016 measured what that command says, in prose,
 * against the pinned build — every shape is quoted in its verification section —
 * and this is how those sentences are put on a stream that is otherwise a real
 * relayed command, rather than hand-written from nothing. `withApiKeySource`'s
 * discipline exactly: the stream is real and the one field under test is the
 * only thing changed.
 */
export function withResultText(events: readonly ClaudeEvent[], text: string): ClaudeEvent[] {
  return events.map((event) => (event.type === 'result' ? { ...event, result: text } : event))
}

/**
 * What `/effort current` answers with, in the three shapes ADR-0016 measured.
 *
 * Quoted rather than paraphrased, because the whole reason the startup
 * self-check compares loosely is that these sentences differ in shape and a
 * release can reword them. A test that invented its own wording would be
 * asserting against roma's guess instead of against the build.
 */
export const EFFORT_ANSWERS = {
  /** A level that landed: what `--effort <level>` produces. */
  at: (level: string): readonly ClaudeEvent[] =>
    withResultText(FREE_RELAY, `Current effort level: ${level}`),
  /** `ultracode`, which reports itself with its description attached. */
  ultracode: (): readonly ClaudeEvent[] =>
    withResultText(
      FREE_RELAY,
      'Current effort level: ultracode (xhigh + dynamic workflow orchestration; ' +
        'this session only)',
    ),
  /** No `--effort` at all — the sentence that names a level roma never asked for. */
  unpinned: (currently = 'high'): readonly ClaudeEvent[] =>
    withResultText(FREE_RELAY, `Effort level: auto (currently ${currently})`),
} as const
