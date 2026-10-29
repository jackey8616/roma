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
 * Enforced by `fence:only-rejected-is-spent`.
 */
export function spentUntil(window: SharedWindow): number | null {
  // Treat anything that is not plainly allowed as spent, to be on the safe side.
  if (window.status === 'allowed') return null
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
