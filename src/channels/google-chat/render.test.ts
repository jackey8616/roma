import { describe, expect, it } from 'vitest'
import { fitted, MAX_TEXT, outcomeMessages, progressText } from './render.js'

const FITTED_WHY =
  "An acknowledgement phrase is fitted to what the mention leaves of Chat's limit, and " +
  '`result.length <= budget` holds at every budget (ADR-0010). Over the limit is no message ' +
  'at all: Chat refuses the whole thing. `tool` was added without anybody thinking about its ' +
  'length and went a release carrying a phrase Chat could refuse (#75); this guard is the one ' +
  'the next phase cannot forget to ask for, and a budget of nothing answered with `…` is one ' +
  'character over (#77).'

// Chat rendering below the Adapter. Everything else that renders is asserted
// through `google-chat-adapter.test.ts`, which is SEAM 3 and says so — a Chat
// event in, a Chat API call out. `fitted` cannot be reached that way: every
// phase of a `TaskProgress` is bounded where it is written, so the longest
// phrase the Adapter can hand it is around 129 characters against a budget of
// roughly 4077.
//
// That is what these tests are for rather than an argument against them. The
// Adapter-level case exercises the tool bound and would stay green if `fitted`
// were deleted, and a guard with no test of its own is indistinguishable from
// dead code at the next refactor. It guards the phase nobody has written yet,
// and #75 is what the last unguarded one cost.
describe('fitting a phrase to Chat', () => {
  // Derived rather than written down: the mention is spent out of the limit
  // before the phrase gets any of it, so a change to how a Caller is addressed
  // moves this. Hard-coding it would leave these passing against a budget that
  // no longer exists.
  const budget = MAX_TEXT - '<users/1234567890> '.length

  it('leaves a phrase inside the budget exactly as it is', () => {
    expect(fitted('Working…', budget)).toBe('Working…')
  })

  it('takes the end of one that is over, and says so', () => {
    const text = fitted('x'.repeat(MAX_TEXT * 2), budget)

    expect(text.length).toBe(budget)
    expect(text.endsWith('…')).toBe(true)
  })

  // The budget is what is left after the mention, so a mention long enough to
  // spend the whole limit leaves nothing — and the ellipsis costs a character
  // like anything else. Answering that with `…` would put the one guard against
  // Chat's limit one character over it.
  it('adds nothing at all when there is no room for the ellipsis [fence:gchat-fitted-holds-the-budget]', () => {
    expect(fitted('rm -rf /home/user/project', 0), FITTED_WHY).toBe('')
    expect(fitted('rm -rf /home/user/project', -5), FITTED_WHY).toBe('')
  })

  // One character of budget is room for the ellipsis and nothing else, which is
  // the boundary the case above is one step past.
  it('spends a budget of one on the ellipsis', () => {
    expect(fitted('rm -rf /home/user/project', 1)).toBe('…')
  })

  // The negative case above is not the only way a slice can read backwards:
  // this is the general promise, and the two edges are where it is easiest to
  // break without noticing.
  it('never returns more than the budget, at any budget [fence:gchat-fitted-holds-the-budget]', () => {
    for (const b of [-1, 0, 1, 2, 3, 10, 128, 4077]) {
      expect(fitted('x'.repeat(5000), b).length, FITTED_WHY).toBeLessThanOrEqual(Math.max(0, b))
    }
  })

  // The one way to reach `fitted` through the acknowledgement: a mention that
  // leaves less room than the shortest phrase. Without this, `progressText`
  // could stop calling `fitted` and every test here would stay green.
  it('keeps the acknowledgement inside the limit whatever the mention leaves [fence:gchat-fitted-holds-the-budget]', () => {
    const caller = `users/${'9'.repeat(MAX_TEXT - 12)}`

    expect(progressText(caller, { phase: 'working' }).length, FITTED_WHY).toBeLessThanOrEqual(
      MAX_TEXT,
    )
  })
})

describe('splitting an answer Chat would refuse', () => {
  it('cuts only at a boundary late in the window, never at an early one [fence:gchat-split-at-a-late-boundary]', () => {
    const why =
      'A full window is cut at its last paragraph, line or word boundary only when that falls ' +
      'in its second half (ADR-0010: an answer arrives as few messages as Chat will take). ' +
      'Accepting any boundary cuts text with an early break and none after it into many tiny ' +
      'messages (#26).'
    const text = `one\n${'x'.repeat(MAX_TEXT * 2)}`

    const messages = outcomeMessages({
      kind: 'result',
      text,
      taskId: 'task-1',
      conversationKey: 'spaces/AAAA/threads/t',
      caller: 'users/17',
      callerName: null,
    })

    expect(messages, why).toHaveLength(3)
    for (const message of messages.slice(0, -1)) {
      expect(message.length, why).toBeGreaterThan(MAX_TEXT / 2)
    }
  })
})
