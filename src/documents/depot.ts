import type { MintsTokens } from '../reach.js'

/**
 * The one folder roma is told the agent works in, as the boot proof found it.
 *
 * A **place and never a boundary** — the boundary is the Document Reach, which
 * is every file shared with the identity, and this is one folder inside it. The
 * two coincide until somebody presses Share, which is why they have different
 * names in CONTEXT.md even while they describe the same files (ADR-0022 §2).
 *
 * Here rather than in the Core because the Core has no use for it: a Depot is
 * what this directory's Reach proves and what its announcement is built from,
 * and nothing outside reads either — `ReachProof` carries the account and
 * nothing else (ADR-0020 §4). The *term* stays in CONTEXT.md, whichever
 * directory the type lives in.
 */
export interface Depot {
  /** The folder id, which is what the agent names as a parent on a create. */
  readonly id: string
  /** What it is called, so that the agent can say where it put something. */
  readonly name: string
}

/**
 * The only thing that holds the Document Reach's key.
 *
 * Two operations, asked at opposite ends of roma's life, which is
 * `InstallationMinter`'s shape and for its reason: startup asks about the Depot
 * once and blocks the boot if the answer is wrong, and everything after that
 * asks only for tokens.
 *
 * `depot()` is here rather than on the Reach because reaching the Depot needs a
 * credential, and the credential is the Minter's. A Reach that had to be handed
 * a token to prove itself would be a Reach that holds one.
 */
export interface DocumentMinter extends MintsTokens {
  /** How the identity names itself, as an operator would recognise it. */
  readonly account: string
  /**
   * Prove the Depot is there and that this identity may put something in it.
   *
   * Throws — with which of the three things is wrong — rather than reporting a
   * folder it could not reach. The three are different mistakes for an operator
   * to go and fix (ADR-0022 §6).
   */
  depot(): Promise<Depot>
}
