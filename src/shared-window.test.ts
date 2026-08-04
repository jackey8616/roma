import { describe, expect, it } from 'vitest'
import { overflowOffer, spentUntil } from './shared-window.js'
import { readSharedWindow } from './stream-events.js'
import { quotaEvent } from '../test/support/recorded-stream.js'

/** The real event every capture carries, and it is always allowed. */
const ALLOWED = quotaEvent()

/**
 * The same event with a status the captures do not hold.
 *
 * The values are Claude Code 2.1.220's own —
 * `v.enum(["allowed","allowed_warning","rejected"])` in its schema for
 * `rate_limit_info` — rather than invented ones. That distinction is most of
 * what this file got wrong before: it was written against `"blocked"`, a string
 * the provider never sends, so it agreed with the code about a case neither of
 * them had seen and said nothing about the case that actually arrives.
 */
const withStatus = (status: string, fields: Record<string, unknown> = {}) =>
  quotaEvent({ status, ...fields })

describe('reading what the stream says about the Shared Window', () => {
  it('reads the event every Turn carries', () => {
    expect(readSharedWindow(ALLOWED)).toEqual({
      status: 'allowed',
      resetsAt: 1785271200,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
    })
  })

  it('is not interested in any other event', () => {
    expect(readSharedWindow({ type: 'system', subtype: 'init' })).toBeNull()
  })
})

describe('deciding the Shared Window is spent', () => {
  it('says a Turn on an allowed window is not blocked', () => {
    expect(spentUntil(readSharedWindow(ALLOWED)!)).toBeNull()
  })

  it('reads a rejected window as spent, and quotes the reset time from the event', () => {
    expect(spentUntil(readSharedWindow(withStatus('rejected'))!)).toBe(1785271200)
  })

  // The bug this change exists for. `allowed_warning` means the window is nearly
  // spent and is still serving — Claude Code goes on answering, and its own
  // renderer ignores the value entirely below 70% utilization. Read as spent, a
  // Turn that failed for some other reason was reported as a quota outage with a
  // reset time, and whatever really failed was never shown to anybody.
  it('does not read a window that is merely close to spent as spent', () => {
    expect(spentUntil(readSharedWindow(withStatus('allowed_warning'))!)).toBeNull()
  })

  // The lesson rather than a preference, and the reverse of the rule that was
  // here before. roma cannot know what a value it has never seen means, and the
  // two ways of being wrong are not symmetric: called spent, an unknown status
  // invents a quota story and buries whatever really failed; called not spent,
  // the Caller gets the failure roma actually observed, in Claude Code's words.
  it('does not invent a quota outage from a status it has never seen', () => {
    expect(spentUntil(readSharedWindow(withStatus('something_later'))!)).toBeNull()
  })

  // A window roma is told is spent and not told when it comes back is one it
  // cannot park a Task against: the Task would wait for a moment that never
  // arrives, and nothing would ever come and look at it again.
  it('refuses to call it spent when the event says nothing about the reset', () => {
    expect(spentUntil(readSharedWindow(withStatus('rejected', { resetsAt: null }))!)).toBeNull()
  })
})

describe('deciding whether Overflow can even be offered', () => {
  // Asked of the event rather than assumed, so that roma never offers a valve
  // the provider will refuse — which would spend somebody's attention on a
  // button and then fail.
  it('is not offered where the event rejects overage', () => {
    expect(overflowOffer(readSharedWindow(withStatus('rejected'))!)).toBe(false)
  })

  it('is offered where the event allows it', () => {
    expect(
      overflowOffer(readSharedWindow(withStatus('rejected', { overageStatus: 'allowed' }))!),
    ).toBe(true)
  })

  // The same mistake as `spentUntil`'s, one field over. `overageStatus` carries
  // the same three values, and `allowed_warning` on it means the account is
  // close to its credit limit and may still spend. Withheld, somebody already
  // waiting on a spent window is denied a valve that works.
  it('is offered where overage is allowed but close to its limit', () => {
    expect(
      overflowOffer(
        readSharedWindow(withStatus('rejected', { overageStatus: 'allowed_warning' }))!,
      ),
    ).toBe(true)
  })

  // Nothing said about overage is not permission to spend metered money.
  it('is not offered where the event says nothing about overage', () => {
    expect(overflowOffer(readSharedWindow(withStatus('rejected', { overageStatus: null }))!)).toBe(
      false,
    )
  })

  // Already on metered billing: there is nothing left to offer, and offering it
  // would read as though the spending had not started.
  it('is not offered to a Turn already running on overage', () => {
    expect(
      overflowOffer(
        readSharedWindow(
          withStatus('rejected', { overageStatus: 'allowed', isUsingOverage: true }),
        )!,
      ),
    ).toBe(false)
  })
})
