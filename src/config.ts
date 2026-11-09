export interface RetryBudget {
  readonly maxApiRetries: number
  readonly windowMs: number
}

export interface RomaConfig {
  readonly maxConcurrentTasks: number
  readonly retryBudget: RetryBudget
}

export const defaultConfig: RomaConfig = {
  maxConcurrentTasks: 3,
  retryBudget: { maxApiRetries: 5, windowMs: 60_000 },
}
