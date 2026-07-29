import { describe, expect, it } from 'vitest'
import { overflowOffer, spentUntil } from './shared-window.js'
import { readSharedWindow } from './stream-events.js'
import { quotaEvent } from '../test/support/recorded-stream.js'

/** The real event every capture carries, and it is always allowed. */
const ALLOWED = quotaEvent()

/** The same event with its status changed — see `spentUntil` for why this is a guess. */
const spent = (fields: Record<string, unknown>) => quotaEvent({ status: 'blocked', ...fields })

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
  // Every capture roma holds says "allowed", so this is the one reading in the
  // system that has never been checked against a real event.
  it('says a Turn on an allowed window is not blocked', () => {
    expect(spentUntil(readSharedWindow(ALLOWED)!)).toBeNull()
  })

  it('reads any other status as spent, and quotes the reset time from the event', () => {
    expect(spentUntil(readSharedWindow(spent({}))!)).toBe(1785271200)
  })

  // A window roma is told is spent and not told when it comes back is one it
  // cannot park a Task against: the Task would wait for a moment that never
  // arrives, and nothing would ever come and look at it again.
  it('refuses to call it spent when the event says nothing about the reset', () => {
    expect(spentUntil(readSharedWindow(spent({ resetsAt: null }))!)).toBeNull()
  })
})

describe('deciding whether Overflow can even be offered', () => {
  // Asked of the event rather than assumed, so that roma never offers a valve
  // the provider will refuse — which would spend somebody's attention on a
  // button and then fail.
  it('is not offered where the event rejects overage', () => {
    expect(overflowOffer(readSharedWindow(spent({}))!)).toBe(false)
  })

  it('is offered where the event allows it', () => {
    expect(overflowOffer(readSharedWindow(spent({ overageStatus: 'allowed' }))!)).toBe(
      true,
    )
  })

  // Already on metered billing: there is nothing left to offer, and offering it
  // would read as though the spending had not started.
  it('is not offered to a Turn already running on overage', () => {
    expect(
      overflowOffer(
        readSharedWindow(spent({ overageStatus: 'allowed', isUsingOverage: true }))!,
      ),
    ).toBe(false)
  })
})
