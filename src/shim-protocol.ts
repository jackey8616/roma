/**
 * The wire between roma and the things in the agent's userland that ask it for a
 * credential, and the two variables that find it.
 *
 * Its own file because both ends need it and neither owns it: `shim-server.ts`
 * is roma's side, the Credential Shims under `src/github/` and the Cloud
 * Shortcut under `src/cloud/` are the other, and a shape defined in any one of
 * them would make the others import a program they have no business loading.
 */

/**
 * Which of roma's two credentials is being asked for.
 *
 * The narrowest addition that works, and it is a word rather than a product:
 * `code` is what reaches anybody's code and `cloud` is what reaches the Cloud
 * Reach. Naming either provider here would put GitHub and Google in the Core,
 * which is the one thing this file exists on the near side of.
 */
export type CredentialWanted = 'code' | 'cloud'

/**
 * What something in the agent's userland asks roma for, one JSON object on one
 * line.
 *
 * Deliberately not the shape of any tool's own protocol. `git` speaks a
 * key-value dialect and `gh` speaks an environment variable, and translating
 * between those and this is each Shim's whole job — which is what keeps the
 * knowledge of either tool out of here and under `src/github/`.
 */
export interface ShimRequest {
  /**
   * Which Session's tool is asking.
   *
   * The Shim reports it from its own environment, and an agent can put anything
   * it likes there. That is not a hole being left open: a Shim is not a boundary
   * against the agent (ADR-0008), and this records the truth about the ordinary
   * path the same way the `Requested-by:` trailer does.
   */
  readonly session: string
  /**
   * `get` for a credential; `erase` to say the one it was given was rejected.
   *
   * Two rather than three: `git` also calls a helper with `store`, and roma has
   * nowhere to store anything — the whole design is that no credential outlives
   * the operation that needed it. The Shim answers that one itself.
   */
  readonly operation: 'get' | 'erase'
  /**
   * What the tool named it was reaching for, where it named one.
   *
   * Null is a real answer and not a gap: `gh api graphql` has no repository to
   * announce. Recorded rather than acted on here — this slice scopes nothing to
   * it — but it is what an Audit Record will be able to say a Task reached for,
   * and foreclosing that is exactly what setting `credential.useHttpPath` avoids.
   */
  readonly path?: string | null
  /** The credential being handed back, on `erase`. */
  readonly token?: string | null
  /**
   * Which credential is wanted. Absent means `code`.
   *
   * Optional so that the two Credential Shims, which predate there being a
   * second credential and ask for the only one they can use, need not say so.
   * The existing fields keep their meanings exactly: `path` stays null for a
   * cloud request, because unlike `git` naming a repository there is no
   * destination to announce — a Cloud Token reaches the whole Cloud Reach and
   * asking the agent to declare a target would record an unverifiable
   * self-report (ADR-0015 §10).
   */
  readonly credential?: CredentialWanted
}

/**
 * What roma answers with: a credential, or why there is not one.
 *
 * The two fields beside the token are the answer's rather than the asker's —
 * roma is the only thing that knows when a token dies or which identity it acts
 * as, and an asker that inferred either would be inventing it. They ride on every
 * successful answer, not only the Cloud Shortcut's: withholding them from the two
 * Credential Shims was minimalism rather than protection, and the branch that did
 * it was where a Reach could be paired with the wrong tokens (ADR-0020 §9).
 *
 * Absent on an answer that carries no token, because there is nothing to say
 * about one that was never minted.
 */
export interface ShimResponse {
  readonly token: string | null
  readonly reason?: string
  /** Epoch milliseconds, as the provider reported it. */
  readonly expiresAt?: number
  /**
   * Which identity the token acts as, or null where roma knows of none.
   *
   * Nullable rather than absent for the null case: "roma answered no account" and
   * "roma did not answer one" are different facts, and a Shortcut that could not
   * tell them apart would report the second when it meant the first.
   */
  readonly account?: string | null
}

/**
 * The one name a Session's Shims are told to look for.
 *
 * Here rather than in the Shims, because roma is what sets it and a second copy
 * of the string is a second place for it to drift.
 */
export const MINTER_SOCKET_VAR = 'ROMA_MINTER_SOCKET'
/** The one name a Shim reports its Session from. */
export const SESSION_ID_VAR = 'ROMA_SESSION_ID'

/** The socket's name inside roma's own directory. */
export function socketPathIn(directory: string): string {
  return `${directory}/minter.sock`
}
