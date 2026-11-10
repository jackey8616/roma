import { describe, expect, it } from 'vitest'
import { nearlyFull, NEARLY_FULL_PERCENT, withNearlyFull } from './context-fill.js'

const held = (tokens: number) => ({ model: 'claude-sonnet-5', tokens })

describe('a context that is nearly full', () => {
  it('starts at the threshold Claude Code’s own /context recommends /compact at [fence:context-fill-threshold-is-claude-codes]', () => {
    const why =
      'The threshold is the 80% at which the pinned build’s /context itself recommends ' +
      '/compact (ADR-0040): roma repeats a recommendation Claude Code makes, never one of ' +
      'its own, and is re-read when the ADR-0007 pin moves.'
    expect(NEARLY_FULL_PERCENT, why).toBe(80)
    expect(nearlyFull(held(795_000), 1_000_000), why).toBe(80)
    expect(nearlyFull(held(794_999), 1_000_000), why).toBeNull()
  })

  it('says nothing when either figure is missing', () => {
    expect(nearlyFull(null, 1_000_000)).toBeNull()
    expect(nearlyFull(held(900_000), null)).toBeNull()
  })

  it('adds the recommendation as a paragraph after the reply', () => {
    expect(withNearlyFull('done', 85)).toBe(
      'done\n\nContext is 85% full. Autocompact will trigger soon, which discards older ' +
        'messages. Use /compact now to control what gets kept.',
    )
    expect(withNearlyFull('done', undefined)).toBe('done')
  })
})
