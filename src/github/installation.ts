import type { MintsTokens } from '../reach.js'

export interface Installation {
  /** An organisation, or a person. */
  readonly account: string
  /** `owner/name`. */
  readonly repositories: readonly string[]
}

/**
 * Startup asks for the Installation once and blocks the boot if the answer does
 * not come; everything after that asks only for tokens.
 */
export interface InstallationMinter extends MintsTokens {
  /** Prove roma can reach its Installation, and report what it reaches. */
  installation(): Promise<Installation>
}
