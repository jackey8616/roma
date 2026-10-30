/**
 * One event off Claude Code's `--output-format stream-json` stdout. Left open
 * because its shape is version-specific: read it through the functions below,
 * which are the only place a version change can break.
 */
export type ClaudeEvent = { readonly type: string } & Readonly<Record<string, unknown>>

/** The terminal `result` event, reduced to the fields roma reads. */
export interface TerminalResult {
  readonly subtype: string
  /**
   * Whether the Turn failed: `is_error`, never `subtype`.
   * Enforced by `fence:session-failure-is-a-rejection`.
   */
  readonly isError: boolean
  readonly text: string | null
  /** Cumulative for the process, not this Turn. Differencing is the caller's job. */
  readonly cumulativeCostUsd: number | null
  readonly stopReason: string | null
  readonly terminalReason: string | null
  /**
   * `num_turns`: how many model Turns the message drove, zero for a local
   * command that answered without one. Null where the event carried no count,
   * which is not zero.
   *
   * Not the Relay drift check's key. Enforced by
   * `fence:core-free-relay-drift-is-one-way`.
   */
  readonly turns: number | null
  /**
   * Output tokens across every model this process has used, off `modelUsage`.
   * Enforced by `fence:stream-output-tokens-summed-across-models`. Cumulative
   * for the process, so differencing is the caller's job.
   *
   * Zero where `modelUsage` is present and empty, as a free Relay reports; null
   * only where it is absent altogether.
   */
  readonly cumulativeOutputTokens: number | null
  /**
   * What went wrong, in Claude Code's own words, or `[]` where it said nothing.
   * Tells a Turn that failed from one that never ran: a 401 has `is_error` and
   * its message in `result` with no `errors`, and a refused `--resume` has its
   * reason here and no `result`. Enforced by `fence:session-refused-resume-read-off-errors`.
   */
  readonly errors: readonly string[]
}

/** The `system/init` event, reduced to what the startup self-check reads. */
export interface SystemInit {
  /**
   * `"none"` under the OAuth token, `"ANTHROPIC_API_KEY"` when a key is present.
   * Reported before the first API call.
   */
  readonly apiKeySource: string | null
  /** The model this process will use. It follows the credential, so it may not be the one asked for. */
  readonly model: string | null
  /** Name it in any mismatch: everything here is version-specific. */
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

/** One `api_retry` event, reduced to what it can tell roma about the failure. */
export interface ApiRetry {
  /** The HTTP status the attempt failed on — 401 for a bad credential. */
  readonly errorStatus: number | null
  /** Claude Code's own name for it, such as `authentication_failed`. */
  readonly error: string | null
}

/**
 * Read an `api_retry` event, or null if this is not one. The only warning that a
 * Turn is going nowhere, minutes before the error itself.
 */
export function readApiRetry(event: ClaudeEvent): ApiRetry | null {
  if (event.type !== 'system' || event['subtype'] !== 'api_retry') return null
  return {
    errorStatus: asNumber(event['error_status']),
    error: asString(event['error']),
  }
}

/**
 * What the stream says about the Shared Window, off `rate_limit_event`, in
 * Claude Code's own field names. What any of it means is `src/shared-window.ts`'s
 * to decide.
 */
export interface SharedWindow {
  /** `"allowed"` in every capture roma holds; what else it can say is unmeasured. */
  readonly status: string | null
  /** When the window comes back, in unix seconds. */
  readonly resetsAt: number | null
  /** `"five_hour"` in every capture. */
  readonly rateLimitType: string | null
  /** Whether the provider would let this account spend past the window at all. */
  readonly overageStatus: string | null
  /** Whether it already is. */
  readonly isUsingOverage: boolean | null
}

/** Read a `rate_limit_event`, or null if this is not one. One arrives on every Turn. */
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

/** One Compaction that happened, off `system/compact_boundary`. */
export interface Compaction {
  /**
   * `"auto"` where the context filled, `"manual"` where somebody asked. Null
   * where the event carried none, which is not `"auto"`.
   */
  readonly trigger: string | null
  /** How much context there was before it, in tokens, or null where unsaid. */
  readonly preTokens: number | null
  /** After it, in tokens, or null where unsaid. */
  readonly postTokens: number | null
}

/**
 * Read a `system/compact_boundary`, or null if this is not one.
 *
 * **`compact_metadata`, snake_case**, not the transcript's `compactMetadata`.
 * Enforced by `fence:stream-compaction-snake-case`.
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
 * A Compaction that was attempted and did not happen: a `system/status` carrying
 * `compact_result`, never a `compact_boundary`.
 */
export interface CompactionFailure {
  /**
   * What went wrong: a code on the automatic path (`too_few_groups`,
   * `exhausted`), a sentence on the asked-for one. What a code means is
   * `src/compaction.ts`'s alone to decide. Null where the event named none.
   */
  readonly code: string | null
}

/**
 * Read a failed Compaction, or null if this event is not one. Only the failure:
 * success is the `compact_boundary` `readCompaction` reads.
 */
export function readCompactionFailure(event: ClaudeEvent): CompactionFailure | null {
  if (event.type !== 'system' || event['subtype'] !== 'status') return null
  if (event['compact_result'] !== 'failed') return null
  return { code: asString(event['compact_error']) }
}

/**
 * Whether this event says a Compaction is under way right now: the only thing on
 * the wire between a `/compact` being sent and its boundary.
 *
 * Read off `status`, not the subtype. Enforced by `fence:stream-compacting-read-off-status`.
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

/** Enforced by `fence:stream-output-tokens-summed-across-models`. */
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
 * Complete messages only. Enforced by `fence:stream-assistant-text-once`.
 */
export function readAssistantText(event: ClaudeEvent): string {
  return contentBlocks(event)
    .map((block) => (block['type'] === 'text' ? (asString(block['text']) ?? '') : ''))
    .join('')
}

/**
 * The prose one event carries as it is being written, or `''` if it carries none:
 * a `text_delta`, the only field that shows prose before its message is finished.
 */
export function readTextDelta(event: ClaudeEvent): string {
  const delta = streamDelta(event)
  if (delta === null || delta['type'] !== 'text_delta') return ''
  return asString(delta['text']) ?? ''
}

/**
 * How much thinking has happened so far, in Claude Code's own estimate, or null.
 * Tokens only: the stream never carries what the thinking is about.
 */
export function readThinkingTokens(event: ClaudeEvent): number | null {
  if (event.type !== 'system' || event['subtype'] !== 'thinking_tokens') return null
  return asNumber(event['estimated_tokens'])
}

/**
 * What Claude Code says it has just started running, or null: `description`,
 * which is the running command itself.
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
 * Always present for a tool call, where only some tools produce a
 * `system/task_started`.
 */
export function readToolNames(event: ClaudeEvent): string[] {
  return contentBlocks(event)
    .filter((block) => block['type'] === 'tool_use')
    .map((block) => asString(block['name']))
    .filter((name): name is string => name !== null)
}

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
