import type { MintsTokens, MintedToken } from './minter.js'

/**
 * How long before expiry a token is treated as spent.
 *
 * Five minutes, and the number is doing two things. It keeps roma from handing
 * out a credential that will die in the middle of the clone it was fetched for —
 * a `git clone` of anything substantial outlasts a few seconds — and it means the
 * refresh happens while the old token is still good, so a mint that fails has not
 * already left roma with nothing.
 *
 * Against a token that lasts an hour this costs one extra mint every twelve
 * hours, which is not a rate limit anybody will notice.
 */
const REFRESH_MARGIN_MS = 5 * 60_000

/**
 * How long after honouring one rejection roma stops honouring others.
 *
 * One token serves everybody, and `git` reports a rejection for reasons that
 * have nothing to do with the credential — the commonest being a repository the
 * Installation does not reach, which authenticates fine and 404s. Without a
 * floor, an agent looping on a name that does not exist would discard the token
 * every other Session is using, once per attempt, and roma would mint on every
 * failed clone. That is the round trip and the rate limit this class exists to
 * avoid, arriving by the back door.
 *
 * A minute is enough to bound it at one mint per minute while leaving the case
 * the discard is *for* intact: an App whose key was rotated has its dead token
 * dropped on the first rejection, and the replacement is in hand before the
 * agent's next command. What is given up is the second rejection inside the
 * minute — and by then roma is already serving a token minted *after* the first
 * one, so a rejection of that is evidence about the request rather than about
 * the credential.
 */
const DISCARD_COOLDOWN_MS = 60_000

export interface FreshTokensOptions {
  readonly minter: MintsTokens
  /** The clock, so that expiry arithmetic can be tested without waiting. */
  readonly now?: () => number
  readonly refreshMarginMs?: number
  readonly discardCooldownMs?: number
  /**
   * Told each time a token is actually minted, rather than served from the one
   * already held.
   *
   * Here rather than at the caller because this is the only thing that knows the
   * difference, and the difference is the whole point of watching: an operator
   * asking "is something minting in a loop" cannot answer it from a count of
   * *requests*, since a Credential Shim asks on every invocation by design and
   * almost all of those are cache hits. Without this, a mint storm and an
   * ordinary busy hour look identical in the log.
   */
  readonly onMint?: () => void
}

/**
 * One minted token, kept for as long as it is worth keeping.
 *
 * Between a Minter and whatever asks it for a credential, and it exists because
 * the two ends want different things. A Credential Shim asks at the moment a
 * tool needs one; minting is a signature and a network round trip, and the
 * provider has a rate limit. So roma mints rarely and answers immediately, which
 * is only safe because of the three rules here.
 *
 * **One class, two credentials.** An Installation Token and a Cloud Token are
 * different in every way except the arithmetic, and the arithmetic is the whole
 * of what is here: refresh before expiry, one mint however many askers, drop
 * what the provider rejected. Two copies of it would be two places for the
 * margin below to be right in, and ADR-0015 says the tricky part is written
 * once. What that costs is the naming — the prose below reaches for `git` for
 * its examples because that is where the behaviour was measured, and the reader
 * should not read those examples as the class's scope.
 *
 * **How much this is actually saving is now measured, and it is less than this
 * class was built expecting.** `git` asks once per operation — one request for a
 * clone, one for a fetch, one for a push — not once per object
 * (`docs/github-app-verification.md`). So the cache saves one round trip per git
 * operation rather than rescuing roma from a rate limit.
 *
 * It still earns its place, on the reasons that survive the number: `gh` asks
 * once per *invocation* and an agent runs many; three Tasks run at once by
 * design, so the single-flight below is about concurrent Sessions rather than
 * about one clone; and a token that expired mid-operation would be a failure
 * nobody could reproduce. What would be an overstatement is calling it
 * load-bearing.
 *
 * **One token for everybody.** No down-scoping, so there is nothing to key a
 * cache on: every Session and both Shims are served by the same string. ADR-0008
 * as amended is where that is argued, and the short version is that `gh`
 * announces no repository, so scoping `git`'s side alone would bound accidents
 * on one path while the other stayed open.
 *
 * **Refreshed before expiry, not at it.** See `REFRESH_MARGIN_MS`.
 *
 * **A rejected token is dropped.** `git` hands a credential back with `erase`
 * when authentication fails — measured, and recorded in ADR-0008's amendment —
 * which is roma's only signal that a token it believes in has stopped working.
 * Without it a rotated or revoked App produces an hour of identical failures.
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
   * Three Tasks run at once by design, and a Session's agent can start as many
   * `git` processes as it likes inside one — so the first refresh after an hour
   * of quiet can be asked for by several Shims in the same tick. Without this
   * they would each mint, which is the round trip this class exists to avoid
   * happening at all, arriving all at once.
   */
  #minting: Promise<MintedToken> | null = null
  /** When roma last threw a token away because it was told to. */
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
   * Rejects with whatever the Minter did. Deliberately not swallowed into a null:
   * the Shim's caller wants to know *why* there is no credential, and the reason
   * is the only thing that distinguishes a bad private key from a forge that is
   * down.
   */
  async current(): Promise<string> {
    return (await this.fresh()).token
  }

  /**
   * The same credential, with the moment it stops being one.
   *
   * A second method rather than widening `current`, because the two callers want
   * different things and the narrower one is the common one. A Credential Shim
   * has nowhere to put an expiry — `git` takes a password and `gh` takes an
   * environment variable — and the Cloud Shortcut's `--json` is the one asker
   * that can say when what it printed dies.
   *
   * The expiry is the provider's answer rather than roma's arithmetic on it, so
   * what `--json` reports is when the token actually expires and not when roma
   * will next refresh.
   */
  async fresh(): Promise<MintedToken> {
    const cached = this.#cached
    if (cached !== null && this.#now() < cached.expiresAt - this.#refreshMarginMs) {
      return cached
    }
    return await this.#mint()
  }

  /**
   * Drop a token the forge has rejected, so the next request mints instead.
   *
   * Two things stop one rejection from becoming a mint on every request, and
   * they guard different mistakes.
   *
   * **Matched on the token itself**, rather than dropping whatever is held. A
   * Shim can hand back a credential that has already been replaced — the erase
   * arrives after a refresh, or a second Session is still using the one it was
   * given — and throwing away the *current* token because an old one failed
   * would be roma re-minting on somebody else's stale news.
   *
   * **And at most once a minute**, because the rejection is not always about the
   * credential. One token serves every Session, and a repository the Installation
   * does not reach authenticates perfectly well and then 404s — so an agent
   * looping on a name that does not exist would otherwise discard everybody's
   * token once per attempt. See `DISCARD_COOLDOWN_MS` for what that gives up.
   */
  discard(token: string): void {
    if (this.#cached?.token !== token) return
    if (this.#now() - this.#discardedAt < this.#discardCooldownMs) return
    this.#discardedAt = this.#now()
    this.#cached = null
  }

  /** Mint once, however many callers are waiting for it. */
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
      // Cleared whichever way it went, and only if this is still the mint in
      // flight. A failed mint that stayed here would be handed to every later
      // caller as a rejection they could do nothing about.
      if (this.#minting === minting) this.#minting = null
    }
  }
}
