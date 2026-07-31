import type { SharedWindow } from './stream-events.js'

/**
 * The three things `status` says on the pinned build, and what each one means.
 *
 * Read out of Claude Code 2.1.220's own schema for `rate_limit_info`, which
 * declares `v.enum(["allowed","allowed_warning","rejected"])`. Named here
 * because the middle one is the whole of why this file was wrong: it is not a
 * degree of `rejected`, it is a degree of `allowed`.
 */
const REJECTED = 'rejected'

/**
 * When the Shared Window comes back, or null if it has not run out.
 *
 * **Only `rejected` is spent.** This used to read "anything that is not
 * `allowed`", chosen deliberately as the shape that survives being wrong — and
 * it did not survive, because the value it had not seen was `allowed_warning`,
 * which means the window is *nearly* spent and is still serving. Claude Code
 * emits it once a utilization threshold is crossed and goes on answering; its
 * own renderer treats it as a banner and ignores it entirely below 70%.
 *
 * What that cost is narrower than it looks, and worth stating exactly so that
 * nobody widens it back by accident. Nothing consults this until an Attempt has
 * already failed — the Core parks only on the failure path — so a healthy Turn
 * was never affected. What was affected is every Turn that failed for some
 * other reason while the window was in warning: roma told the Caller the shared
 * quota was spent and quoted a reset time, parked the Task, and ran it again up
 * to twice more, with the real error — a 500, a dead process, a Retry Storm —
 * nowhere in what anybody was told.
 *
 * An unrecognised status is **not** spent, which is the opposite of the old
 * rule and is the lesson rather than a preference. roma cannot know what a value
 * it has never seen means, and the two ways of being wrong are not symmetric:
 * reading an unknown status as spent invents a quota story and hides a real
 * failure, where reading it as not-spent reports the failure roma actually
 * observed, in Claude Code's own words. A wrong answer that shows its working
 * beats a confident one that does not.
 *
 * Null also when the event will not say when the window comes back, which is a
 * different judgement: a Task parked against a moment that never arrives waits
 * for ever, and nothing else in roma will come and look at it. Better a Task
 * that fails and can be sent again.
 */
export function spentUntil(window: SharedWindow): number | null {
  if (window.status !== REJECTED) return null
  return window.resetsAt
}

/**
 * Whether Overflow is worth offering for a Task this window has blocked.
 *
 * Asked of the event rather than assumed from configuration, because the
 * provider has the last word: offering a valve it will refuse spends somebody's
 * attention on a button and then fails, at the moment they are already waiting.
 *
 * `overageStatus` carries the same three values as `status` and they mean the
 * same things about a different pot, so `allowed_warning` is offered here too.
 * It says the account is close to its usage credit limit and may still spend —
 * Claude Code's own reading of the pair is "You're close to your usage limit",
 * a warning rather than a refusal. Declining to offer on it would withhold a
 * valve that works from somebody already waiting on a spent window, which is
 * the same mistake `spentUntil` above was making, one field over.
 *
 * `rejected` is the one that means no, and `overageDisabledReason` says which
 * kind of no — `no_limits_configured` in every capture roma holds.
 *
 * False for a Turn already using overage. There is nothing left to offer, and an
 * offer would read as though the metered spending had not already started.
 */
export function overflowOffer(window: SharedWindow): boolean {
  if (window.overageStatus === null || window.overageStatus === REJECTED) return false
  return window.isUsingOverage !== true
}
