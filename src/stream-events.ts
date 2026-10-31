export type ClaudeEvent = { readonly type: string } & Readonly<Record<string, unknown>>

export interface TerminalResult {
  readonly subtype: string
  readonly isError: boolean
  readonly text: string | null
  readonly cumulativeCostUsd: number | null
  readonly stopReason: string | null
  readonly terminalReason: string | null
  readonly turns: number | null
  readonly cumulativeOutputTokens: number | null
  readonly errors: readonly string[]
}

export interface SystemInit {
  readonly apiKeySource: string | null
  readonly model: string | null
  readonly claudeCodeVersion: string | null
}

export function readSystemInit(event: ClaudeEvent): SystemInit | null {
  if (event.type !== 'system' || event['subtype'] !== 'init') return null
  return {
    apiKeySource: asString(event['apiKeySource']),
    model: asString(event['model']),
    claudeCodeVersion: asString(event['claude_code_version']),
  }
}

export interface ApiRetry {
  readonly errorStatus: number | null
  readonly error: string | null
}

export function readApiRetry(event: ClaudeEvent): ApiRetry | null {
  if (event.type !== 'system' || event['subtype'] !== 'api_retry') return null
  return {
    errorStatus: asNumber(event['error_status']),
    error: asString(event['error']),
  }
}

export interface SharedWindow {
  readonly status: string | null
  readonly resetsAt: number | null
  readonly rateLimitType: string | null
  readonly overageStatus: string | null
  readonly isUsingOverage: boolean | null
}

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

export interface Compaction {
  readonly trigger: string | null
  readonly preTokens: number | null
  readonly postTokens: number | null
}

export function readCompaction(event: ClaudeEvent): Compaction | null {
  if (event.type !== 'system' || event['subtype'] !== 'compact_boundary') return null
  const fields = fieldsOf(event['compact_metadata'])
  return {
    trigger: asString(fields['trigger']),
    preTokens: asNumber(fields['pre_tokens']),
    postTokens: asNumber(fields['post_tokens']),
  }
}

export interface CompactionFailure {
  readonly code: string | null
}

export function readCompactionFailure(event: ClaudeEvent): CompactionFailure | null {
  if (event.type !== 'system' || event['subtype'] !== 'status') return null
  if (event['compact_result'] !== 'failed') return null
  return { code: asString(event['compact_error']) }
}

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

export function readTerminalResult(event: ClaudeEvent): TerminalResult | null {
  if (event.type !== 'result') return null
  return {
    subtype: asString(event['subtype']) ?? '',
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

function outputTokensIn(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null
  let total = 0
  for (const model of Object.values(value as Record<string, unknown>)) {
    total += asNumber(fieldsOf(model)['outputTokens']) ?? 0
  }
  return total
}

export function readAssistantText(event: ClaudeEvent): string {
  return contentBlocks(event)
    .map((block) => (block['type'] === 'text' ? (asString(block['text']) ?? '') : ''))
    .join('')
}

export function readTextDelta(event: ClaudeEvent): string {
  const delta = streamDelta(event)
  if (delta === null || delta['type'] !== 'text_delta') return ''
  return asString(delta['text']) ?? ''
}

export function readThinkingTokens(event: ClaudeEvent): number | null {
  if (event.type !== 'system' || event['subtype'] !== 'thinking_tokens') return null
  return asNumber(event['estimated_tokens'])
}

export function readToolStarted(event: ClaudeEvent): string | null {
  if (event.type !== 'system' || event['subtype'] !== 'task_started') return null
  return asString(event['description'])
}

export function readToolFinished(event: ClaudeEvent): boolean {
  return event.type === 'system' && event['subtype'] === 'task_notification'
}

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

function fieldsOf(value: unknown): Record<string, unknown> {
  return (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}
