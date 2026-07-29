import type { SharedWindow } from './stream-events.js'

/** What every capture roma holds reports, on a window with room in it. */
const ALLOWED = 'allowed'

/**
 * When the Shared Window comes back, or null if it has not run out.
 *
 * **This is the one reading in roma that has never been checked against a real
 * event, and the guess is in a specific place: what `status` says when the
 * window is spent.** Every capture in `test/fixtures/claude-stream/` reports
 * `"allowed"`, ADR-0002 quotes that same event, and measuring the other case
 * means deliberately draining the window everybody shares — which blocks the
 * whole team, the token's owner included, until it resets.
 *
 * So the rule is "anything that is not `allowed`" rather than a value this
 * claims to know, which is the shape that survives being wrong: a status roma
 * has never seen parks a Task and explains itself, rather than running it into a
 * wall. Being wrong the other way — reading a spent window as allowed — is what
 * would leave somebody with a bare failure and no reset time. Correct it here
 * and nowhere else once somebody has seen one.
 *
 * Null also when the event will not say when the window comes back, which is a
 * different judgement: a Task parked against a moment that never arrives waits
 * for ever, and nothing else in roma will come and look at it. Better a Task
 * that fails and can be sent again.
 */
export function spentUntil(window: SharedWindow): number | null {
  if (window.status === null || window.status === ALLOWED) return null
  return window.resetsAt
}

/**
 * Whether Overflow is worth offering for a Task this window has blocked.
 *
 * Asked of the event rather than assumed from configuration, because the
 * provider has the last word: offering a valve it will refuse spends somebody's
 * attention on a button and then fails, at the moment they are already waiting.
 * `overageStatus` is `"rejected"` in every capture roma holds, with
 * `overageDisabledReason: "no_limits_configured"` beside it.
 *
 * False for a Turn already using overage. There is nothing left to offer, and an
 * offer would read as though the metered spending had not already started.
 */
export function overflowOffer(window: SharedWindow): boolean {
  return window.overageStatus === ALLOWED && window.isUsingOverage !== true
}
