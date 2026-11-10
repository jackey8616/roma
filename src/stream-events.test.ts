import { describe, expect, it } from 'vitest'
import {
  readAssistantText,
  readContextHeld,
  readContextWindow,
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

describe('how much context a Session holds', () => {
  const turn = recordedStream('tool-use-turn').turn(1)
  const held = turn.map(readContextHeld).filter((reading) => reading !== null)
  const [result] = turn.filter((event) => event.type === 'result') as [ClaudeEvent]

  it('is read off the last API call, never off the Turn’s summed usage [fence:stream-context-held-is-the-last-call]', () => {
    const why =
      'readContextHeld reads one assistant message’s usage, and roma takes the last one ' +
      '(ADR-0040): `result.usage` is summed over every API call in a Turn, so a three-call ' +
      'tool-use Turn reports about three times the context it holds.'
    const usage = result['usage'] as Record<string, number>
    const summed =
      (usage['input_tokens'] ?? 0) +
      (usage['cache_read_input_tokens'] ?? 0) +
      (usage['cache_creation_input_tokens'] ?? 0)

    expect(held.at(-1), why).toEqual({ model: 'claude-sonnet-5', tokens: 32_625 })
    expect(summed, why).toBeGreaterThan(90_000)
  })

  it('reads the window of the model that answered', () => {
    expect(readContextWindow(result, 'claude-sonnet-5')).toBe(1_000_000)
    expect(readContextWindow(result, 'a-model-that-did-not-run')).toBeNull()
  })
})
