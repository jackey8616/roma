import type { MintsTokens, MintedToken } from './reach.js'

/**
 * How long before expiry a token is treated as spent.
 *
 * Five minutes, doing two things: a credential handed out must not die in the
 * middle of the clone it was fetched for, and the refresh has to happen while
 * the old token is still good, so a failed mint leaves roma with something.
 */
const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * How long after honouring one rejection roma stops honouring others.
 *
 * One token serves everybody, and `git` reports rejections that say nothing
 * about the credential — commonest is a repository the Installation cannot
 * reach, which authenticates fine and 404s. Without a floor, an agent looping on
 * a name that does not exist discards the token every other Session is using,
 * once per attempt, and roma mints on every failed clone.
 *
 * A minute leaves the case the discard is *for* intact: a rotated key has its
 * dead token dropped on the first rejection. What is given up is the second
 * rejection inside the minute, by which point roma is already serving a token
 * minted after the first.
 */
const DISCARD_COOLDOWN_MS = 60_000

export interface FreshTokensOptions {
  readonly minter: MintsTokens
  /** The clock, so that expiry arithmetic can be tested without waiting. */
  readonly now?: () => number
  readonly refreshMarginMs?: number
  readonly discardCooldownMs?: number
  /** Told each time a token is actually minted, rather than served from the one already held. */
  readonly onMint?: () => void
}

/**
 * One minted token, kept for as long as it is worth keeping, between a Minter
 * and whatever asks it for a credential.
 *
 * Every asker is served the same token. It is refreshed before it expires rather
 * than at it, minted once however many ask at the same moment, and dropped when
 * the provider rejects it.
 */
export class FreshTokens {
  readonly #minter: MintsTokens
  readonly #now: () => number
  readonly #refreshMarginMs: number
  readonly #discardCooldownMs: number
  readonly #onMint: () => void

  #cached: MintedToken | null = null
  /**
   * The mint in flight, or null.
   *
   * Three Tasks run at once and an agent can start any number of `git`
   * processes inside one, so the first refresh after an hour of quiet can be
   * asked for by several Shims in the same tick. Without this they each mint.
   */
  #minting: Promise<MintedToken> | null = null
  #discardedAt = Number.NEGATIVE_INFINITY

  constructor({
    minter,
    now = Date.now,
    refreshMarginMs = REFRESH_MARGIN_MS,
    discardCooldownMs = DISCARD_COOLDOWN_MS,
    onMint = () => {},
  }: FreshTokensOptions) {
    this.#minter = minter
    this.#now = now
    this.#refreshMarginMs = refreshMarginMs
    this.#discardCooldownMs = discardCooldownMs
    this.#onMint = onMint
  }

  /**
   * A token good enough to hand to a tool right now.
   *
   * Rejects with whatever the Minter did, never with a null: the reason is the
   * only thing that tells a bad private key from a forge that is down.
   */
  async current(): Promise<string> {
    return (await this.fresh()).token
  }

  /**
   * The same credential, with the moment it stops being one: the provider's
   * expiry, not when roma will next refresh.
   */
  async fresh(): Promise<MintedToken> {
    const cached = this.#cached
    if (cached !== null && this.#now() < cached.expiresAt - this.#refreshMarginMs) {
      return cached
    }
    return await this.#mint()
  }

  /**
   * Drop a token the provider has rejected, so the next request mints instead.
   *
   * Only the token named, and at most once a minute; see `DISCARD_COOLDOWN_MS`
   * for what that gives up. Enforced by `fence:session-token-discard-is-narrow`.
   */
  discard(token: string): void {
    if (this.#cached?.token !== token) return
    if (this.#now() - this.#discardedAt < this.#discardCooldownMs) return
    this.#discardedAt = this.#now()
    this.#cached = null
  }

  async #mint(): Promise<MintedToken> {
    const inFlight = this.#minting
    if (inFlight !== null) return await inFlight

    const minting = this.#minter.mint()
    this.#minting = minting
    try {
      const minted = await minting
      this.#cached = minted
      // After the mint rather than before it, so the log counts credentials
      // actually produced rather than attempts — a provider that is refusing
      // every request is a different event, and the caller reports that one.
      this.#onMint()
      return minted
    } finally {
      // Enforced by `fence:session-token-failed-mint-is-forgotten`.
      if (this.#minting === minting) this.#minting = null
    }
  }
}
