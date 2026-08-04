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
  /**
   * Prove this Reach works, or block the boot.
   *
   * Asked once, at startup, before anything that could accept an Ingress Message
   * exists. A key that is syntactically perfect and revoked is a blind spot no
   * amount of parsing closes, so roma uses the key rather than reading it — and a
   * failure that surfaced instead as an inexplicable `git clone` inside somebody's
   * Turn would read as "roma is broken" with no diagnosis attached (ADR-0008).
   *
   * **Throwing is the only way to report a Reach that is configured and does not
   * work.** Returning the unavailable arm instead would tell every Session that
   * this deployment has no such Reach, which for a revoked key is a lie
   * (ADR-0020 §2).
   */
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
 * request for it with. "There is none" is an answer roma gives out loud rather
 * than a case it has no branch for (ADR-0015 §9) — and a Reach that were simply
 * missing would read, to whatever consulted it, as one that does not apply, which
 * is how an agent ends up investigating its `PATH`.
 *
 * Reachable from a key that is absent and from nothing else. See `prove`.
 */
export type UnavailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly unavailable: string
}

export type Reach<C extends CredentialWanted = CredentialWanted> =
  AvailableReach<C> | UnavailableReach<C>

/**
 * One Reach per credential roma can be asked for.
 *
 * A record over `CredentialWanted` rather than a list, and the difference is
 * ADR-0008. A list cannot say "one per credential", so a roma with no `code`
 * Reach would typecheck — and would prove no key at boot, announce nothing, and
 * fail every `git` request inside somebody's Turn, which is the exact failure
 * blocking the boot exists to prevent. `CredentialWanted` is closed, so this is
 * total by construction and the composition root cannot leave a member out.
 *
 * `code` is an `AvailableReach` because required means required: there is no
 * development mode that skips the forge credential, and now no way to spell one.
 * `cloud` and `documents` are the full union because ADR-0015 §9 and ADR-0022 §8
 * make their unavailable arm the ordinary case — most deployments have neither.
 */
export interface Reaches {
  readonly code: AvailableReach<'code'>
  readonly cloud: Reach<'cloud'>
  readonly documents: Reach<'documents'>
}

/**
 * Every Reach, in the order they are proved and announced.
 *
 * The order is `code` first, and it is load-bearing rather than alphabetical: a
 * deployment broken in several ways is told about the free check first, and a
 * boot with a bad App key makes no network call to Google at all (ADR-0020 §4).
 */
export function eachReach(reaches: Reaches): readonly Reach[] {
  return [reaches.code, reaches.cloud, reaches.documents]
}
