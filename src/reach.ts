import type { CredentialWanted } from './shim-protocol.js'

/**
 * One minted credential, and the moment it stops being one. The expiry is the
 * provider's answer, never inferred from a lifetime constant, so a provider that
 * shortens it shortens roma's refresh clock with it.
 */
export interface MintedToken {
  readonly token: string
  /** Epoch milliseconds, as the provider reported it. */
  readonly expiresAt: number
}

/**
 * Something that turns a long-lived key into something short-lived. It does not
 * cache: refreshing before expiry, serving concurrent askers from one mint, and
 * discarding a rejected token are all `FreshTokens`'.
 */
export interface MintsTokens {
  mint(): Promise<MintedToken>
}

/**
 * What a Reach learned about itself by proving it works. `account` is null where
 * a Reach is unavailable; an available Reach that proved with no account is
 * representable and no factory produces one.
 */
export interface ReachProof {
  readonly account: string | null
}

interface Reaching<C extends CredentialWanted> {
  /** Enforced by `fence:reach-typed-by-its-credential`. */
  readonly credential: C
  /** Prove this Reach works, or block the boot. Enforced by `fence:reach-a-broken-key-blocks-the-boot`. */
  prove(): Promise<ReachProof>
  /** Enforced by `fence:reach-announces-only-what-it-proved`. */
  announce(): string
}

/** A Reach with a key behind it: it can be asked for a credential. */
export type AvailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly minter: MintsTokens
}

/**
 * A Reach this deployment was given no key for, carrying the sentence roma
 * answers a request for it with. Enforced by
 * `fence:reach-no-key-is-a-reach-that-says-so`.
 *
 * Reachable from a key that is absent and from nothing else. See `prove`.
 */
export type UnavailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly unavailable: string
}

export type Reach<C extends CredentialWanted = CredentialWanted> =
  AvailableReach<C> | UnavailableReach<C>

/**
 * One Reach per credential roma can be asked for, and `code` always available.
 * Enforced by `fence:reach-one-per-credential`.
 */
export interface Reaches {
  readonly code: AvailableReach<'code'>
  readonly cloud: Reach<'cloud'>
  readonly documents: Reach<'documents'>
}

/**
 * Every Reach, in the order they are proved and announced: `code` first.
 * Enforced by `fence:reach-code-is-proved-first`.
 */
export function eachReach(reaches: Reaches): readonly Reach[] {
  return [reaches.code, reaches.cloud, reaches.documents]
}
