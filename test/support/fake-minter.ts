import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Installation, Minter, MintedToken } from '../../src/minter.js'
import type { MintingOptions } from '../../src/startup.js'

/** An hour, which is how long a real Installation Token lasts. */
const HOUR_MS = 60 * 60_000

export interface FakeMinterOptions {
  readonly installation?: Installation
  /** What every mint fails with, where minting is meant to fail. */
  readonly failsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

/**
 * A Minter with no App behind it.
 *
 * What the port is for. Everything that decides anything about credentials —
 * caching, refreshing, single-flight, discarding a rejected token, and the boot
 * that blocks on an unreachable Installation — is roma's, and all of it can be
 * asserted against this without a private key, a network, or a real GitHub App.
 */
export class FakeMinter implements Minter {
  /** Every token this has produced, in order. Tokens are `token-1`, `token-2`. */
  readonly minted: MintedToken[] = []
  /** How many times the Installation has been asked for. */
  installations = 0
  /** Set to make the next mint, and every mint after it, fail. */
  failsWith: Error | null

  readonly #installation: Installation
  readonly #lifetimeMs: number
  readonly #now: () => number

  constructor({
    installation = { account: 'a-team', repositories: ['a-team/roma'] },
    failsWith,
    lifetimeMs = HOUR_MS,
    now = Date.now,
  }: FakeMinterOptions = {}) {
    this.#installation = installation
    this.failsWith = failsWith ?? null
    this.#lifetimeMs = lifetimeMs
    this.#now = now
  }

  installation(): Promise<Installation> {
    this.installations += 1
    if (this.failsWith !== null) return Promise.reject(this.failsWith)
    return Promise.resolve(this.#installation)
  }

  mint(): Promise<MintedToken> {
    if (this.failsWith !== null) return Promise.reject(this.failsWith)
    const minted: MintedToken = {
      token: `token-${String(this.minted.length + 1)}`,
      expiresAt: this.#now() + this.#lifetimeMs,
    }
    this.minted.push(minted)
    return Promise.resolve(minted)
  }
}

/**
 * Everything `startRoma` needs to put a credential in front of a Session, with
 * nothing real behind it.
 *
 * The socket directory is a throwaway of its own rather than anything under the
 * test's work root, which is the same separation the real thing keeps: a socket
 * under a tree that gets reclaimed is every credential request failing at once.
 */
export function fakeMinting(overrides: Partial<MintingOptions> = {}): MintingOptions & {
  readonly minter: FakeMinter
} {
  const minter = (overrides.minter as FakeMinter | undefined) ?? new FakeMinter()
  return {
    minter,
    socketDir: overrides.socketDir ?? mkdtempSync(join(tmpdir(), 'roma-shims-')),
    gitConfig: overrides.gitConfig ?? '[credential]\n\tuseHttpPath = true\n',
    announce: overrides.announce ?? ((installation) => `reaches ${installation.repositories.join(', ')}`),
  }
}
