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
   * Read for the Readout drift check (ADR-0012) and for nothing else. Every
   * entry on the Readout list answers locally on the pinned build, measured, so
   * anything above zero means the pin has moved and an entry has quietly become
   * something that spends money.
   *
   * Null where the event carried no count. Not folded into zero: "it drove no
   * Turn" and "this build does not say" are different facts, and only the first
   * of them is the one being asserted.
   */
  readonly turns: number | null
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
  const info = event['rate_limit_info']
  const fields = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>
  return {
    status: asString(fields['status']),
    resetsAt: asNumber(fields['resetsAt']),
    rateLimitType: asString(fields['rateLimitType']),
    overageStatus: asString(fields['overageStatus']),
    isUsingOverage: typeof fields['isUsingOverage'] === 'boolean' ? fields['isUsingOverage'] : null,
  }
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
  }
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

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
