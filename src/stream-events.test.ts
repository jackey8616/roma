import { describe, expect, it } from 'vitest'
import {
  readAssistantText,
  readTerminalResult,
  readTextDelta,
  type ClaudeEvent,
} from './stream-events.js'
import { GENERATING, recordedStream } from '../test/support/recorded-stream.js'

describe('the prose of a generating Turn', () => {
  it('is read once, off the complete message and never off the deltas [fence:stream-assistant-text-once]', () => {
    const why =
      'readAssistantText must read complete `assistant` messages only, never `stream_event` ' +
      'deltas (ADR-0003). With --include-partial-messages the same prose arrives both ways, ' +
      'so a reader of both doubles it, and a Turn whose terminal event carries no text puts ' +
      'the answer in the thread twice.'
    const deltas = GENERATING.map(readTextDelta).join('')
    const read = GENERATING.map(readAssistantText).join('')

    expect(deltas).toHaveLength(17706)
    expect(read, why).toBe(deltas)
  })
})

describe('the output tokens a terminal event reports', () => {
  const [result] = recordedStream('three-turns-one-process')
    .turn(1)
    .filter((event) => event.type === 'result') as [ClaudeEvent]
  const why =
    'cumulativeOutputTokens must sum every model in `modelUsage`, and an entry that does not ' +
    'say must add nothing rather than null the sum (ADR-0018). The Relay drift check asks ' +
    'whether any model did work: a /compact charges its summary to whichever model Claude Code ' +
    "picked, which need not be the Session's, and an unreadable entry may hide its own work " +
    'but never the work another entry did.'

  it('sums every model, not the one the Session runs on [fence:stream-output-tokens-summed-across-models]', () => {
    expect(readTerminalResult(result)?.cumulativeOutputTokens, why).toBe(17)
  })

  it('counts what the other entries say when one of them says nothing [fence:stream-output-tokens-summed-across-models]', () => {
    const usage = result['modelUsage'] as Record<string, Record<string, unknown>>
    const { outputTokens, ...unsaid } = usage['claude-haiku-4-5-20251001'] ?? {}
    void outputTokens
    const oneSaysNothing = {
      ...result,
      modelUsage: { ...usage, 'claude-haiku-4-5-20251001': unsaid },
    }

    expect(readTerminalResult(oneSaysNothing)?.cumulativeOutputTokens, why).toBe(4)
  })
})
