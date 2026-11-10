import type { MintsTokens, MintedToken } from './reach.js'

const REFRESH_MARGIN_MS = 5 * 60_000

const DISCARD_COOLDOWN_MS = 60_000

export interface FreshTokensOptions {
  readonly minter: MintsTokens
  readonly now?: () => number
  readonly refreshMarginMs?: number
  readonly discardCooldownMs?: number
  readonly onMint?: () => void
}

export class FreshTokens {
  readonly #minter: MintsTokens
  readonly #now: () => number
  readonly #refreshMarginMs: number
  readonly #discardCooldownMs: number
  readonly #onMint: () => void

  #cached: MintedToken | null = null
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

  async current(): Promise<string> {
    return (await this.fresh()).token
  }

  async fresh(): Promise<MintedToken> {
    const cached = this.#cached
    if (cached !== null && this.#now() < cached.expiresAt - this.#refreshMarginMs) {
      return cached
    }
    return await this.#mint()
  }

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
      this.#onMint()
      return minted
    } finally {
      if (this.#minting === minting) this.#minting = null
    }
  }
}
