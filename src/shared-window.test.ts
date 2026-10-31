import { describe, expect, it } from 'vitest'
import { overflowOffer, spentUntil } from './shared-window.js'
import { readSharedWindow } from './stream-events.js'
import { quotaEvent } from '../test/support/recorded-stream.js'

const ALLOWED = quotaEvent()

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

describe('deciding the Shared Window is spent [fence:only-rejected-is-spent]', () => {
  const WHY =
    'Only `rejected` is spent (ADR-0002, Quota exhaustion). Nothing reads this until an ' +
    'Attempt has already failed, so widening it hides the real failure: a Turn that failed ' +
    'for another reason while the window was `allowed_warning`, or on a status roma has never ' +
    'seen, is reported as a quota outage, parked, and rerun with the real error shown to ' +
    'nobody (#83). A spent window with no `resetsAt` is not parked either: nothing would ever ' +
    'wake the Task.'

  it('says a Turn on an allowed window is not blocked', () => {
    expect(spentUntil(readSharedWindow(ALLOWED)!), WHY).toBeNull()
  })

  it('reads a rejected window as spent, and quotes the reset time from the event', () => {
    expect(spentUntil(readSharedWindow(withStatus('rejected'))!), WHY).toBe(1785271200)
  })

  it('does not read a window that is merely close to spent as spent', () => {
    expect(spentUntil(readSharedWindow(withStatus('allowed_warning'))!), WHY).toBeNull()
  })

  it('does not invent a quota outage from a status it has never seen', () => {
    expect(spentUntil(readSharedWindow(withStatus('something_later'))!), WHY).toBeNull()
  })

  it('refuses to call it spent when the event says nothing about the reset', () => {
    expect(
      spentUntil(readSharedWindow(withStatus('rejected', { resetsAt: null }))!),
      WHY,
    ).toBeNull()
  })
})

describe('deciding whether Overflow can even be offered', () => {
  it('is not offered where the event rejects overage', () => {
    expect(overflowOffer(readSharedWindow(withStatus('rejected'))!)).toBe(false)
  })

  it('is offered where the event allows it', () => {
    expect(
      overflowOffer(readSharedWindow(withStatus('rejected', { overageStatus: 'allowed' }))!),
    ).toBe(true)
  })

  it('is offered where overage is allowed but close to its limit [fence:window-overflow-offered-on-warning]', () => {
    const why =
      'Overflow must be offered on overageStatus `allowed_warning` (ADR-0002, Overflow). It ' +
      'carries the same three values as `status`: `allowed_warning` means the account is close ' +
      'to its credit limit and may still spend — Claude Code reads it as "You\'re close to your ' +
      'usage limit". Offering only on `allowed` withholds a valve that works from somebody ' +
      'already waiting on a spent window, the mistake spentUntil made one field over (#83).'
    expect(
      overflowOffer(
        readSharedWindow(withStatus('rejected', { overageStatus: 'allowed_warning' }))!,
      ),
      why,
    ).toBe(true)
  })

  it('is not offered where the event says nothing about overage', () => {
    expect(overflowOffer(readSharedWindow(withStatus('rejected', { overageStatus: null }))!)).toBe(
      false,
    )
  })

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
