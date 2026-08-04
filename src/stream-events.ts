/**
 * One event off Claude Code's `--output-format stream-json` stdout.
 *
 * Left open on purpose. The stream is not ours: its shape is version-specific
 * and grows without warning, so the only honest type is "a JSON object that has
 * a `type`". Everything roma actually depends on is read out through the
 * functions below, which is also the only place a version change can break.
 */
export type ClaudeEvent = { readonly type: string } & Readonly<Record<string, unknown>>

/** The terminal `result` event, reduced to the fields roma reads. */
export interface TerminalResult {
  readonly subtype: string
  /**
   * Whether the Turn failed.
   *
   * This, never `subtype`. `is_error: true` co-occurs with `subtype: "success"`
   * on every auth failure the prototype observed, so a reader keying on
   * `subtype` reports failures as successes.
   */
  readonly isError: boolean
  readonly text: string | null
  /** Cumulative for the whole Session, not this Turn. Differencing is the caller's job. */
  readonly cumulativeCostUsd: number | null
  readonly stopReason: string | null
  readonly terminalReason: string | null
  /**
   * How many model Turns the message drove — `num_turns`, and zero for a local
   * command that answered without one.
   *
   * **Not the Relay drift check's key any more, and ADR-0018 is where that was
   * measured false.** A manual `/compact` moved `total_cost_usd` by $0.0453 over
   * 28,545ms and reported `num_turns: 0`: an entry that stays `type:"local"` and
   * starts doing model work is invisible here. `cumulativeOutputTokens` below is
   * what the check reads instead. This is kept because it is still what the
   * stream says about a message, and it is what tells a local command apart from
   * a prompt — the other shape an entry can drift into.
   *
   * Null where the event carried no count. Not folded into zero: "it drove no
   * Turn" and "this build does not say" are different facts, and only the first
   * of them is the one being asserted.
   */
  readonly turns: number | null
  /**
   * Output tokens across every model this process has used, cumulative.
   *
   * Summed off `modelUsage`, which is the one field that moves when a
   * `type:"local"` command does model work: on the measured `/compact` the
   * top-level `usage` was all zeros, `duration_api_ms` was 0 and `num_turns` was
   * 0, while `modelUsage` moved by +2,019 input and +1,978 output tokens.
   *
   * Cumulative for the *process* the way `total_cost_usd` is, so differencing is
   * the caller's job — `ClaudeSession` does it, for the reason it does it there.
   *
   * Output rather than input, and tokens rather than money. The membership rule a
   * Relay is judged against is about **model work**; money is a function of model
   * work that also moves with pricing, plans and which model answered, so a
   * zero-cost model would silently retire the check while the behaviour it
   * watches carried on. Input moves for reasons that are not the entry's doing —
   * a cache read is counted there — and output does not.
   *
   * Zero where the object is present and empty, which is what a free Relay
   * reports (`modelUsage: {}` on `readout-context.jsonl`). Null only where the
   * field is absent altogether, which is a build that has stopped saying rather
   * than a Turn that did nothing.
   */
  readonly cumulativeOutputTokens: number | null
  /**
   * What went wrong, in Claude Code's own words, or `[]` where it said nothing.
   *
   * The field that tells a Turn which *failed* apart from one that never ran. A
   * 401 arrives as `is_error: true` with the message in `result` and no `errors`
   * at all; a `--resume` pointed at a Transcript that is not there arrives with
   * the reason here and no `result` beside it — which is the whole of how
   * `TranscriptNotFound` is recognised, and why reading it is not optional
   * detail. `resume-lost.jsonl` and `auth-failure.jsonl` are the two captures,
   * one each way.
   *
   * An array rather than the first entry, because it is an array in the stream
   * and roma has seen exactly one length of it. Whoever meets a longer one
   * should see all of it.
   */
  readonly errors: readonly string[]
}

/** The `system/init` event, reduced to what the startup self-check reads. */
export interface SystemInit {
  /**
   * Where Claude Code resolved its credential from.
   *
   * `"none"` under the OAuth token and `"ANTHROPIC_API_KEY"` when a key is
   * present. The only field in the stream that says which of the two is paying,
   * and it says so before the first API call — which is what makes it worth
   * asserting on at boot rather than after a Turn.
   */
  readonly apiKeySource: string | null
  /**
   * The model this process will actually use.
   *
   * Not necessarily the one asked for: it follows the credential. Measured under
   * a stray key without `--model` pinned, the prototype got `claude-opus-5[1m]`.
   */
  readonly model: string | null
  /** Everything here is version-specific, so a mismatch needs to name the build. */
  readonly claudeCodeVersion: string | null
}

/**
 * Read a `system/init` event, or null if this is not one.
 *
 * One arrives at the start of every Turn, not once per process — nothing may
 * treat it as a spawn signal.
 */
export function readSystemInit(event: ClaudeEvent): SystemInit | null {
  if (event.type !== 'system' || event['subtype'] !== 'init') return null
  return {
    apiKeySource: asString(event['apiKeySource']),
    model: asString(event['model']),
    claudeCodeVersion: asString(event['claude_code_version']),
  }
}

/**
 * One `api_retry` event, reduced to what it can tell roma about the failure.
 *
 * The attempt number Claude Code puts on these is deliberately not read: roma
 * counts the retries it has seen itself, so its budget stays its own rather
 * than a reflection of the CLI's `max_retries`.
 */
export interface ApiRetry {
  /** The HTTP status the attempt failed on — 401 for a bad credential. */
  readonly errorStatus: number | null
  /** Claude Code's own name for it, such as `authentication_failed`. */
  readonly error: string | null
}

/**
 * Read an `api_retry` event, or null if this is not one.
 *
 * These are the only warning roma gets that a Turn is going nowhere. A bad
 * credential does not fail fast — the prototype saw ten of these across 182
 * seconds before the 401 itself surfaced — so a Task that waits for the error
 * proper holds a concurrency slot for over three minutes.
 */
export function readApiRetry(event: ClaudeEvent): ApiRetry | null {
  if (event.type !== 'system' || event['subtype'] !== 'api_retry') return null
  return {
    errorStatus: asNumber(event['error_status']),
    error: asString(event['error']),
  }
}

/**
 * What the stream says about the Shared Window, off `rate_limit_event`.
 *
 * The field names are Claude Code's own, kept rather than translated, because a
 * reader comparing this to a capture should not have to. What any of it *means*
 * is `src/shared-window.ts`, which is the only place that judgement is made.
 */
export interface SharedWindow {
  /** `"allowed"` in every capture roma holds. What else it can say is unmeasured. */
  readonly status: string | null
  /** When the window comes back, in unix seconds. The real source for what users are told. */
  readonly resetsAt: number | null
  /** `"five_hour"` in every capture — the rolling window ADR-0002 turns on. */
  readonly rateLimitType: string | null
  /** Whether the provider would let this account spend past the window at all. */
  readonly overageStatus: string | null
  /** Whether it already is. */
  readonly isUsingOverage: boolean | null
}

/**
 * Read a `rate_limit_event`, or null if this is not one.
 *
 * One arrives on every Turn, so this is how roma learns where the Shared Window
 * stands without asking anybody.
 */
export function readSharedWindow(event: ClaudeEvent): SharedWindow | null {
  if (event.type !== 'rate_limit_event') return null
  const fields = fieldsOf(event['rate_limit_info'])
  return {
    status: asString(fields['status']),
    resetsAt: asNumber(fields['resetsAt']),
    rateLimitType: asString(fields['rateLimitType']),
    overageStatus: asString(fields['overageStatus']),
    isUsingOverage: typeof fields['isUsingOverage'] === 'boolean' ? fields['isUsingOverage'] : null,
  }
}

/**
 * One Compaction that happened, off `system/compact_boundary`.
 *
 * Claude Code replacing a Session's conversation with a summary so that it still
 * fits. roma neither asks for it nor can prevent it — what it can do is say that
 * it happened, because a Turn carrying one cost 4.9 times the same Turn without
 * one and nothing else in roma would ever explain the difference.
 */
export interface Compaction {
  /**
   * Why it happened: `"auto"` where the context filled, `"manual"` where
   * somebody asked.
   *
   * Claude Code's own two values — `enum(["manual","auto"])` in the wire schema —
   * kept as the string rather than turned into a boolean, because the pair is
   * what answers "who paid for this and did they choose it". Only `auto` has been
   * observed; the other half arrives with ADR-0018's `/compact`.
   *
   * Null where the event carried none. Not folded into `"auto"`: a Compaction
   * roma cannot attribute is a different fact from one it can, and the Audit
   * Record is the last place to start guessing.
   */
  readonly trigger: string | null
  /** How much context there was before it, in tokens, or null where unsaid. */
  readonly preTokens: number | null
  /** And after — the pair is how much context the money bought. */
  readonly postTokens: number | null
}

/**
 * Read a `system/compact_boundary`, or null if this is not one.
 *
 * **`compact_metadata`, snake_case.** The camelCase `compactMetadata` that #98
 * was written against is Claude Code's *transcript* spelling; the stream carries
 * it through a mapper on the way out. A reader written from the transcript finds
 * `undefined`, reports every Compaction as no Compaction, and looks like it
 * works — which is the whole reason #100 measured this before anything was built
 * on it. `compaction-auto.jsonl` is the capture.
 *
 * `cumulative_dropped_tokens` is deliberately not read. It is cumulative for the
 * process the way `total_cost_usd` is, so a Task that reported it would be
 * describing every Compaction the Session has ever had as its own.
 */
export function readCompaction(event: ClaudeEvent): Compaction | null {
  if (event.type !== 'system' || event['subtype'] !== 'compact_boundary') return null
  const fields = fieldsOf(event['compact_metadata'])
  return {
    trigger: asString(fields['trigger']),
    preTokens: asNumber(fields['pre_tokens']),
    postTokens: asNumber(fields['post_tokens']),
  }
}

/**
 * A Compaction that was attempted and did not happen, off `system/status`.
 *
 * Not a `compact_boundary` at all — there is no boundary, because nothing was
 * replaced. It arrives on the same event that carries ordinary progress
 * (`status: "requesting"`, `status: "compacting"`), marked only by
 * `compact_result` being present.
 */
export interface CompactionFailure {
  /**
   * Claude Code's own name for what went wrong — `too_few_groups`, `exhausted`.
   *
   * **A code rather than a sentence**, which is what makes reading it at all
   * acceptable: #98 rejected matching on the error *text* as the mistake
   * `shared-window.ts` already made once, and that rejection turns out to cost
   * nothing. What the codes mean is `src/compaction.ts`, and nothing else in roma
   * may decide it.
   *
   * Null where the event named none, which no capture roma holds does.
   */
  readonly code: string | null
}

/**
 * Read a failed Compaction, or null if this event is not one.
 *
 * Only the failure. Success is announced by the `compact_boundary` above — a
 * `compact_result: "success"` arrives just before one and says strictly less, so
 * reading both would be two answers to one question with a moment in between
 * where they disagree.
 */
export function readCompactionFailure(event: ClaudeEvent): CompactionFailure | null {
  if (event.type !== 'system' || event['subtype'] !== 'status') return null
  if (event['compact_result'] !== 'failed') return null
  return { code: asString(event['compact_error']) }
}

/**
 * Whether this event says a Compaction is under way right now.
 *
 * The only thing on the wire between a `/compact` being sent and the boundary
 * arriving, and the gap it covers was measured at up to 28,517ms. Without it the
 * Acknowledgement idles for the whole of that — the same dead-stream shape
 * `readToolStarted` exists for, and the failure ADR-0003 named when it argued the
 * concurrency cap: "unacknowledged waiting causes users to resend".
 *
 * The same event carries `compact_result` when a Compaction has *finished*, so
 * this reads the `status` field rather than the subtype: a `status: null` event
 * announcing a result is not an announcement that work is starting.
 */
export function readCompacting(event: ClaudeEvent): boolean {
  return (
    event.type === 'system' && event['subtype'] === 'status' && event['status'] === 'compacting'
  )
}

export function parseEvent(line: string): ClaudeEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const event = parsed as Record<string, unknown>
  if (typeof event['type'] !== 'string') return null
  return event as ClaudeEvent
}

/**
 * Read the terminal `result` event, or null if this is not one.
 *
 * Every Turn ends with exactly one of these — one per *Turn*, not one per
 * process exit.
 */
export function readTerminalResult(event: ClaudeEvent): TerminalResult | null {
  if (event.type !== 'result') return null
  return {
    subtype: asString(event['subtype']) ?? '',
    // Fail closed. `is_error` is always present in every capture we hold; if a
    // future version stops emitting it, a Turn of unknown outcome is a failure
    // rather than a silent success.
    isError: typeof event['is_error'] === 'boolean' ? event['is_error'] : true,
    text: asString(event['result']),
    cumulativeCostUsd: asNumber(event['total_cost_usd']),
    stopReason: asString(event['stop_reason']),
    terminalReason: asString(event['terminal_reason']),
    turns: asNumber(event['num_turns']),
    cumulativeOutputTokens: outputTokensIn(event['modelUsage']),
    errors: asStrings(event['errors']),
  }
}

/**
 * Output tokens across every model in one `modelUsage` object, or null if there
 * is no such object.
 *
 * Summed, never read per model: the drift check asks whether *any* model did
 * work, and a `/compact` charges the summarisation to whichever model Claude
 * Code picked — the measured capture has a `claude-haiku-4-5` entry beside the
 * Session's own `claude-sonnet-5`.
 *
 * An entry with no `outputTokens` contributes nothing rather than nulling the
 * sum: an unreadable entry may hide work it did, never work another entry did.
 */
function outputTokensIn(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  let total = 0
  for (const model of Object.values(value as Record<string, unknown>)) {
    total += asNumber(fieldsOf(model)['outputTokens']) ?? 0
  }
  return total
}

/**
 * The text an `assistant` event carries, concatenated across its text blocks.
 *
 * Complete messages only. With `--include-partial-messages` the same prose also
 * arrives as `stream_event` deltas; reading both would double it.
 */
export function readAssistantText(event: ClaudeEvent): string {
  return contentBlocks(event)
    .map((block) => (block['type'] === 'text' ? (asString(block['text']) ?? '') : ''))
    .join('')
}

/**
 * The prose one event carries as it is being written, or `''` if it carries none.
 *
 * `stream_event.event.delta.text`, on a `content_block_delta` whose delta is a
 * `text_delta`. The only field in the stream that shows prose before the message
 * carrying it is finished, and therefore the only thing a progress message can
 * be made of. Seam 2 measured 194 of these across a 72-second generating Turn,
 * the longest gap between any two events 2641ms — so an update on a 5-second
 * throttle always has something new to show.
 */
export function readTextDelta(event: ClaudeEvent): string {
  const delta = streamDelta(event)
  if (delta === null || delta['type'] !== 'text_delta') return ''
  return asString(delta['text']) ?? ''
}

/**
 * How much thinking has happened so far, in Claude Code's own estimate, or null.
 *
 * Tokens, and only tokens. `thinking_delta` arrives with `"thinking": ""`, so
 * the content is not in the stream to be read: progress can say that thinking
 * is happening and roughly how much, never what it is about.
 */
export function readThinkingTokens(event: ClaudeEvent): number | null {
  if (event.type !== 'system' || event['subtype'] !== 'thinking_tokens') return null
  return asNumber(event['estimated_tokens'])
}

/**
 * What Claude Code says it has just started running, or null.
 *
 * The one thing that makes a tool window bearable. The stream marks a tool
 * starting and then says nothing whatsoever until it finishes — 25339ms in the
 * capture, against a largest generating gap of 208ms in the same Turn — and
 * `description` is the running command itself.
 */
export function readToolStarted(event: ClaudeEvent): string | null {
  if (event.type !== 'system' || event['subtype'] !== 'task_started') return null
  return asString(event['description'])
}

/** Whether this event closes a tool window `readToolStarted` opened. */
export function readToolFinished(event: ClaudeEvent): boolean {
  return event.type === 'system' && event['subtype'] === 'task_notification'
}

/**
 * The tools an `assistant` event is asking to run, in the order it named them.
 *
 * The other end of a tool window, and the end that is always there: only some
 * tools produce a `system/task_started`, but every tool call arrives as a
 * `tool_use` block on an `assistant` message first.
 */
export function readToolNames(event: ClaudeEvent): string[] {
  return contentBlocks(event)
    .filter((block) => block['type'] === 'tool_use')
    .map((block) => asString(block['name']))
    .filter((name): name is string => name !== null)
}

/** The content blocks of an `assistant` event's message, or `[]` if it has none. */
function contentBlocks(event: ClaudeEvent): Record<string, unknown>[] {
  if (event.type !== 'assistant') return []
  const message = event['message']
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return []
  return content.filter(
    (block: unknown): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null,
  )
}

/** The `delta` of a `content_block_delta` stream event, or null if it is not one. */
function streamDelta(event: ClaudeEvent): Record<string, unknown> | null {
  if (event.type !== 'stream_event') return null
  const inner = event['event']
  if (typeof inner !== 'object' || inner === null) return null
  const { type, delta } = inner as Record<string, unknown>
  if (type !== 'content_block_delta') return null
  if (typeof delta !== 'object' || delta === null) return null
  return delta as Record<string, unknown>
}

/**
 * The fields of an object an event nests inside itself, or `{}` where it carries
 * none.
 *
 * Absent, null, and not-an-object all mean the same thing here — every field
 * below is missing. Written once so a reader added later gets the three-way
 * coercion right by not having to write it.
 */
function fieldsOf(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The strings of an array field, dropping anything that is not one. */
function asStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}
