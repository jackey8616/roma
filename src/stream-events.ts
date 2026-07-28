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
  }
}

/**
 * The text an `assistant` event carries, concatenated across its text blocks.
 *
 * Complete messages only. With `--include-partial-messages` the same prose also
 * arrives as `stream_event` deltas; reading both would double it.
 */
export function readAssistantText(event: ClaudeEvent): string {
  if (event.type !== 'assistant') return ''
  const message = event['message']
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>)['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return ''
      const { type, text } = block as Record<string, unknown>
      return type === 'text' && typeof text === 'string' ? text : ''
    })
    .join('')
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
