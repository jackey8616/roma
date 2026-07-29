/**
 * How much retrying roma will sit through before it abandons a Task.
 *
 * Both limits, not either: the count is what actually fires under a bad
 * credential, and the wall-clock is the backstop for the day the backoff is
 * stretched further than the count reaches.
 */
export interface RetryBudget {
  /**
   * Retries tolerated in one Turn. The Turn is abandoned on the retry that
   * reaches this number.
   */
  readonly maxApiRetries: number
  /** How long a Turn may go on retrying, measured from its first retry. */
  readonly windowMs: number
}

/**
 * The numbers ADR-0003 fixed for the Task queue, in one place.
 *
 * Here rather than inline at the two places that read them, because they are one
 * decision rather than two: the retry budget exists to keep a misconfigured
 * credential from holding one of `maxConcurrentTasks` slots, so the pair only
 * makes sense read together. Both are overridable per instance — `TaskQueue`
 * takes the cap, `SessionPool` takes the budget — and these are what roma uses
 * when nobody says otherwise.
 */
export interface RomaConfig {
  /**
   * Tasks that may run at once across every Session.
   *
   * Three. Beyond that a Task queues and its caller is told where it is, because
   * unacknowledged waiting makes people resend, which compounds the backlog.
   */
  readonly maxConcurrentTasks: number
  readonly retryBudget: RetryBudget
}

/**
 * Five retries or sixty seconds, whichever comes first.
 *
 * Sized against a measurement rather than a guess. The prototype's bad
 * credential produced ten `api_retry` events across 182 seconds, the backoff
 * stretching from 580ms to about 35 seconds, before the 401 surfaced — so one
 * misconfiguration held a concurrency slot for over three minutes, and three of
 * them halt roma with no Task hanging at all.
 *
 * Against that observed backoff the count is what fires: retries at roughly
 * 0.6s, 1.2s, 2.5s, 5s and 9s reach five in under twenty seconds. The window is
 * for the case the count would not catch — a backoff already at 35 seconds
 * between attempts — and bounds a wedged slot at a minute either way.
 *
 * Five rather than three so that a genuine transient overload still gets a few
 * attempts to succeed. A Task abandoned here is a Task the person has to send
 * again, and doing that to work that would have completed is its own failure.
 */
export const defaultConfig: RomaConfig = {
  maxConcurrentTasks: 3,
  retryBudget: { maxApiRetries: 5, windowMs: 60_000 },
}
