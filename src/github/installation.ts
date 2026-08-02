import type { MintsTokens } from '../reach.js'

/**
 * What roma reaches on the forge, and who it is acting as.
 *
 * The whole of the boundary, which is why it is a value roma holds rather than a
 * question it asks per request: every Conversation reaches all of it, and so does
 * everyone who can message roma (ADR-0008).
 *
 * Here rather than in the Core because the Core has no use for it. An
 * Installation is what this directory's Reach proves and what its announcement is
 * built from, and nothing outside reads either — `ReachProof` carries the account
 * and nothing else (ADR-0020 §4). The *term* stays in CONTEXT.md: a term that is
 * the whole of a security property should be a term, whichever directory the type
 * lives in.
 */
export interface Installation {
  /** How the Installation names itself — an organisation, or a person. */
  readonly account: string
  /** Every repository it reaches, `owner/name`. */
  readonly repositories: readonly string[]
}

/**
 * The only thing that holds the App's private key.
 *
 * Two operations, asked at opposite ends of roma's life. Startup asks for the
 * Installation once and blocks the boot if the answer does not come; everything
 * after that asks only for tokens.
 */
export interface InstallationMinter extends MintsTokens {
  /** Prove roma can reach its Installation, and report what it reaches. */
  installation(): Promise<Installation>
}
