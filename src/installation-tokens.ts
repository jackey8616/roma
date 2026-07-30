import type { Minter, MintedToken } from './minter.js'

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

export interface InstallationTokensOptions {
  readonly minter: Minter
  /** The clock, so that expiry arithmetic can be tested without waiting. */
  readonly now?: () => number
  readonly refreshMarginMs?: number
}

/**
 * One Installation Token, kept for as long as it is worth keeping.
 *
 * Between the Minter and the Credential Shims, and it exists because the two
 * ends want different things. A Shim asks at the moment a tool needs a
 * credential, which is often — `git` asks on every operation, and `gh` asks once
 * per invocation. Minting is a JWT signature and two network round trips, and
 * the App has a rate limit. So roma mints rarely and answers immediately, which
 * is only safe because of the three rules here.
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
export class InstallationTokens {
  readonly #minter: Minter
  readonly #now: () => number
  readonly #refreshMarginMs: number

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

  constructor({ minter, now = Date.now, refreshMarginMs = REFRESH_MARGIN_MS }: InstallationTokensOptions) {
    this.#minter = minter
    this.#now = now
    this.#refreshMarginMs = refreshMarginMs
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
    const cached = this.#cached
    if (cached !== null && this.#now() < cached.expiresAt - this.#refreshMarginMs) {
      return cached.token
    }
    return (await this.#mint()).token
  }

  /**
   * Drop a token the forge has rejected, so the next request mints instead.
   *
   * Matched on the token itself rather than dropping whatever is held. A Shim can
   * hand back a credential that has already been replaced — the erase arrives
   * after a refresh, or a second Session is still using the one it was given —
   * and throwing away the *current* token because an old one failed would turn
   * one dead credential into a mint on every request.
   */
  discard(token: string): void {
    if (this.#cached?.token === token) this.#cached = null
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
      return minted
    } finally {
      // Cleared whichever way it went, and only if this is still the mint in
      // flight. A failed mint that stayed here would be handed to every later
      // caller as a rejection they could do nothing about.
      if (this.#minting === minting) this.#minting = null
    }
  }
}
