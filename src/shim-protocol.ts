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
 * Which of roma's three credentials is being asked for: `code` reaches anybody's
 * code, `cloud` the Cloud Reach, and `documents` the Document Reach.
 * Enforced by `fence:shim-credential-wanted-is-closed`.
 */
export type CredentialWanted = 'code' | 'cloud' | 'documents'

/**
 * What something in the agent's userland asks roma for, one JSON object on one
 * line. Not the shape of any tool's own protocol: translating to it is each
 * Shim's job.
 */
export interface ShimRequest {
  /**
   * Which Session's tool is asking, as the Shim read it from its own environment:
   * self-reported, so the agent can put anything there.
   */
  readonly session: string
  /**
   * `get` for a credential; `erase` to say the one it was given was rejected.
   * `git`'s `store` never reaches roma: the Shim answers it itself.
   */
  readonly operation: 'get' | 'erase'
  /**
   * What the tool named it was reaching for, where it named one. Null is a real
   * answer and not a gap: `gh api graphql` has no repository to announce.
   * Recorded, and nothing is scoped to it.
   */
  readonly path?: string | null
  /** The credential being handed back, on `erase`. */
  readonly token?: string | null
  /**
   * Which credential is wanted. Absent means `code`, so the two Credential Shims
   * need not say so. `path` stays null for a `cloud` or `documents` request.
   */
  readonly credential?: CredentialWanted
}

/**
 * What roma answers with: a credential, or why there is not one. `expiresAt` and
 * `account` ride on every answer that carries a token, whichever credential was
 * asked for, and are absent on one that carries none.
 */
export interface ShimResponse {
  readonly token: string | null
  readonly reason?: string
  /** Epoch milliseconds, as the provider reported it. */
  readonly expiresAt?: number
  /**
   * Which identity the token acts as, or null where roma knows of none. Null
   * ("roma answered no account") and absent ("roma did not answer one") are
   * different facts.
   */
  readonly account?: string | null
}

/**
 * The one name a Session's Shims are told to look for.
 * Enforced by `fence:shim-variables-named-once`.
 */
export const MINTER_SOCKET_VAR = 'ROMA_MINTER_SOCKET'
/**
 * The one name a Shim reports its Session from.
 * Enforced by `fence:shim-variables-named-once`.
 */
export const SESSION_ID_VAR = 'ROMA_SESSION_ID'

/** The socket's name inside roma's own directory. */
export function socketPathIn(directory: string): string {
  return `${directory}/minter.sock`
}
