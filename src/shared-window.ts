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
  if (window.status !== REJECTED) return null
  return window.resetsAt
}

/**
 * Whether Overflow is worth offering for a Task this window has blocked.
 * Enforced by `fence:window-overflow-offered-on-warning`.
 *
 * False for a Turn already using overage: there is nothing left to offer, and an
 * offer would read as though the metered spending had not already started.
 */
export function overflowOffer(window: SharedWindow): boolean {
  if (window.overageStatus === null || window.overageStatus === REJECTED) return false
  return window.isUsingOverage !== true
}
