import { describe, expect, it } from 'vitest'
import { fitted, MAX_TEXT, outcomeMessages, progressText } from './render.js'

const FITTED_WHY =
  "An acknowledgement phrase is fitted to what the mention leaves of Chat's limit, and " +
  '`result.length <= budget` holds at every budget (ADR-0010). Over the limit is no message ' +
  'at all: Chat refuses the whole thing. `tool` was added without anybody thinking about its ' +
  'length and went a release carrying a phrase Chat could refuse (#75); this guard is the one ' +
  'the next phase cannot forget to ask for, and a budget of nothing answered with `…` is one ' +
  'character over (#77).'

describe('fitting a phrase to Chat', () => {
  const budget = MAX_TEXT - '<users/1234567890> '.length

  it('leaves a phrase inside the budget exactly as it is', () => {
    expect(fitted('Working…', budget)).toBe('Working…')
  })

  it('takes the end of one that is over, and says so', () => {
    const text = fitted('x'.repeat(MAX_TEXT * 2), budget)

    expect(text.length).toBe(budget)
    expect(text.endsWith('…')).toBe(true)
  })

  it('adds nothing at all when there is no room for the ellipsis [fence:gchat-fitted-holds-the-budget]', () => {
    expect(fitted('rm -rf /home/user/project', 0), FITTED_WHY).toBe('')
    expect(fitted('rm -rf /home/user/project', -5), FITTED_WHY).toBe('')
  })

  it('spends a budget of one on the ellipsis', () => {
    expect(fitted('rm -rf /home/user/project', 1)).toBe('…')
  })

  it('never returns more than the budget, at any budget [fence:gchat-fitted-holds-the-budget]', () => {
    for (const b of [-1, 0, 1, 2, 3, 10, 128, 4077]) {
      expect(fitted('x'.repeat(5000), b).length, FITTED_WHY).toBeLessThanOrEqual(Math.max(0, b))
    }
  })

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
