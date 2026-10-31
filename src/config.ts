/**
 * How much retrying roma will sit through before it abandons a Task: whichever
 * limit is reached first.
 */
export interface RetryBudget {
  /** Retries tolerated in one Turn; the Turn is abandoned on the retry that reaches it. */
  readonly maxApiRetries: number
  /** How long a Turn may go on retrying, measured from its first retry. */
  readonly windowMs: number
}

/**
 * The Task Queue's numbers. Both are overridable per instance: `TaskQueue` takes
 * the cap, `SessionPool` takes the budget.
 */
export interface RomaConfig {
  /** Tasks that may run at once across every Session. */
  readonly maxConcurrentTasks: number
  readonly retryBudget: RetryBudget
}

export const defaultConfig: RomaConfig = {
  maxConcurrentTasks: 3,
  retryBudget: { maxApiRetries: 5, windowMs: 60_000 },
}
