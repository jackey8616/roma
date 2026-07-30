/**
 * The wire between a Credential Shim and roma, and the two variables that find
 * it.
 *
 * Its own file because both ends need it and neither owns it: `shim-server.ts`
 * is roma's side, the Shims under `src/github/` are the other, and a shape
 * defined in either one would make the other import a program it has no business
 * loading.
 */

/**
 * What a Credential Shim asks roma for, one JSON object on one line.
 *
 * Deliberately not the shape of either tool's own protocol. `git` speaks a
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
}

/** What roma answers with: a credential, or why there is not one. */
export interface ShimResponse {
  readonly token: string | null
  readonly reason?: string
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
