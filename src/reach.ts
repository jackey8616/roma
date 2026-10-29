import type { CredentialWanted } from './shim-protocol.js'

/**
 * The whole of what the Core knows about reaching anything roma does not own.
 *
 * Ports, and narrow ones on purpose. Everything that knows which forge this is —
 * the App id, the private key, the JWT, the REST calls — lives under
 * `src/github/`, and `src/github-containment.test.ts` is what keeps it there;
 * everything that knows which cloud this is lives under `src/cloud/`, kept by
 * `src/cloud-containment.test.ts`. The justification is the testing seam rather
 * than a third provider nobody has asked for: behind these, `wiring.test.ts` can
 * still assemble roma out of real parts, and the free run stays free.
 *
 * What the Core sees is one Reach per credential and nothing else — not a forge,
 * not a cloud, and not two arrangements that happen to rhyme (ADR-0020).
 */

/**
 * One minted credential, and the moment it stops being one.
 *
 * The expiry rides along rather than being inferred from a lifetime constant,
 * because how long a token lasts is the provider's answer and not roma's — roma
 * refreshes against what it was told, so a provider that shortens the hour
 * shortens roma's clock with it.
 */
export interface MintedToken {
  readonly token: string
  /** Epoch milliseconds, as the provider reported it. */
  readonly expiresAt: number
}

/**
 * Something that turns a long-lived key into something short-lived.
 *
 * The half of a Reach that holds the key, and the whole of what `FreshTokens`
 * needs — which is why it is a type of its own rather than a comment on a
 * resemblance. The arithmetic that keeps a token fresh is about expiry and
 * concurrency and has no opinion about which credential it is holding, so it is
 * written once against this and reused for every Reach there is.
 *
 * It does not cache. Refreshing before expiry, serving concurrent askers from
 * one mint, and discarding a token the provider rejected are all
 * `FreshTokens`' — decisions about arithmetic and timing rather than about a
 * product, and they are tested against a fake of this.
 */
export interface MintsTokens {
  mint(): Promise<MintedToken>
}

/**
 * What a Reach learned about itself by proving it works.
 *
 * One field, and deliberately no second one. A Reach reports no inventory of what
 * it reaches: the Cloud Reach has none to report by decision (ADR-0015), and the
 * Installation's repository list is what its own announcement is built from and
 * is nobody else's business. Giving this a field for it so the two could match
 * would be inventing a shape rather than finding one.
 *
 * Null where a Reach is unavailable. An available Reach that proved with no
 * account is representable and no factory produces one; the null is here for the
 * arm that never proves anything.
 */
export interface ReachProof {
  readonly account: string | null
}

interface Reaching<C extends CredentialWanted> {
  /**
   * Which credential this Reach answers requests for.
   *
   * A type parameter rather than the bare union, so that the slot a Reach fills
   * and the credential it answers for cannot disagree. Without it
   * `{ code: cloudReachFrom(env), cloud: githubReachFrom(env) }` typechecks, and
   * a `git` would be handed a Cloud Token — the failure that looks like
   * everything working right up to the first API call.
   */
  readonly credential: C
  /** Prove this Reach works, or block the boot. Enforced by `fence:reach-a-broken-key-blocks-the-boot`. */
  prove(): Promise<ReachProof>
  /**
   * What every Session is told it can reach, or `''` where there is nothing to
   * say.
   *
   * **Call it after `prove`.** It reads what the proof found — a Reach that
   * announces before proving throws rather than announcing a capability it has
   * not checked, because the empty version of most announcements reads as "you
   * have no access" and an agent told that stops trying (ADR-0020).
   */
  announce(): string
}

/** A Reach with a key behind it: it can be asked for a credential. */
export type AvailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly minter: MintsTokens
}

/**
 * A Reach this deployment was given no key for.
 *
 * Present rather than absent, always, and carrying the sentence roma answers a
 * request for it with. Enforced by `fence:reach-no-key-is-a-reach-that-says-so`.
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
 *
 * `cloud` and `documents` are the full union because ADR-0015 §9 and ADR-0022 §8
 * make their unavailable arm the ordinary case — most deployments have neither.
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
