import type { ClaudeEvent } from './stream-events.js'

/**
 * What the stream says about the Shared Window, as `rate_limit_event` reports it.
 *
 * One arrives on every Turn. The fields are Claude Code's own names, kept rather
 * than renamed, because the whole of this file is a reading of somebody else's
 * event and a reader comparing it to a capture should not have to translate.
 */
export interface Quota {
  /** `"allowed"` in every capture roma holds. What else it can say is unmeasured. */
  readonly status: string | null
  /** When the window comes back, in unix seconds. The real source for what users are told. */
  readonly resetsAt: number | null
  /** `"five_hour"` in every capture — the rolling window ADR-0002 turns on. */
  readonly rateLimitType: string | null
  /** Whether the provider would let this account spend past the window at all. */
  readonly overageStatus: string | null
  /** Whether it already is. */
  readonly isUsingOverage: boolean | null
}

/**
 * Read a `rate_limit_event`, or null if this is not one.
 *
 * Purely mechanical — every judgement made about what it *means* is in the two
 * functions below, so that there is one place to correct when the meaning is
 * finally measured.
 */
export function readQuota(event: ClaudeEvent): Quota | null {
  if (event.type !== 'rate_limit_event') return null
  const info = event['rate_limit_info']
  const fields = (typeof info === 'object' && info !== null ? info : {}) as Record<string, unknown>
  return {
    status: asString(fields['status']),
    resetsAt: asNumber(fields['resetsAt']),
    rateLimitType: asString(fields['rateLimitType']),
    overageStatus: asString(fields['overageStatus']),
    isUsingOverage: typeof fields['isUsingOverage'] === 'boolean' ? fields['isUsingOverage'] : null,
  }
}

/** What every capture roma holds reports, on a window with room in it. */
const ALLOWED = 'allowed'

/**
 * When the Shared Window comes back, or null if it has not run out.
 *
 * **This is the one reading in roma that has never been checked against a real
 * event, and it is a guess in a specific place: what `status` says when the
 * window is spent.** Every capture in `test/fixtures/claude-stream/` reports
 * `"allowed"`, ADR-0002 quotes that same event, and measuring the other case
 * means deliberately draining the window everybody shares — which blocks the
 * whole team, the token's owner included, until it resets.
 *
 * So the rule is "anything that is not `allowed`" rather than a value this
 * claims to know, which is the shape that survives being wrong: a new status
 * roma has never seen is treated as spent, and a Task is parked and answered
 * rather than run into a wall. Being wrong the other way — reading a spent
 * window as allowed — is what would leave people with a failure and no reset
 * time. Correct it here and nowhere else once somebody has seen one.
 *
 * Null also when the event will not say when the window comes back, which is not
 * the same judgement: a Task parked against a moment that never arrives waits
 * for ever, and nothing else in roma will come and look at it. Better a Task
 * that fails and can be sent again.
 */
export function spentUntil(quota: Quota): number | null {
  if (quota.status === null || quota.status === ALLOWED) return null
  return quota.resetsAt
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
export function overflowOffer(quota: Quota): boolean {
  return quota.overageStatus === ALLOWED && quota.isUsingOverage !== true
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
