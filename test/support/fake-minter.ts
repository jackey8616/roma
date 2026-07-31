import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudMinter, Installation, Minter, MintedToken } from '../../src/minter.js'
import type { CloudOptions, MintingOptions } from '../../src/startup.js'

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

export interface FakeCloudMinterOptions {
  readonly account?: string
  /** What every mint fails with, where minting is meant to fail. */
  readonly failsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

/**
 * A Cloud Reach with no cloud behind it.
 *
 * The other half of what the ports are for. The boot proof that blocks on a key
 * that does not work, the freshness the socket serves a second request from, and
 * the sentence a Session is told can all be asserted against this — with no
 * service account key, no network, and no Google.
 *
 * Tokens are `cloud-token-1`, `cloud-token-2`, deliberately unlike the
 * `token-1` the forge's fake produces: every test that asserts a cloud request
 * was not answered with an Installation Token rests on being able to tell the
 * two apart at a glance.
 */
export class FakeCloudMinter implements CloudMinter {
  readonly account: string
  /** Every token this has produced, in order. */
  readonly minted: MintedToken[] = []
  /** Set to make the next mint, and every mint after it, fail. */
  failsWith: Error | null

  readonly #lifetimeMs: number
  readonly #now: () => number

  constructor({
    account = 'agent@a-project.iam.gserviceaccount.com',
    failsWith,
    lifetimeMs = HOUR_MS,
    now = Date.now,
  }: FakeCloudMinterOptions = {}) {
    this.account = account
    this.failsWith = failsWith ?? null
    this.#lifetimeMs = lifetimeMs
    this.#now = now
  }

  mint(): Promise<MintedToken> {
    if (this.failsWith !== null) return Promise.reject(this.failsWith)
    const minted: MintedToken = {
      token: `cloud-token-${String(this.minted.length + 1)}`,
      expiresAt: this.#now() + this.#lifetimeMs,
    }
    this.minted.push(minted)
    return Promise.resolve(minted)
  }
}

/** A Cloud Reach for `startRoma`, with a fake announcement and nothing real. */
export function fakeCloud(overrides: Partial<CloudOptions> = {}): CloudOptions & {
  readonly minter: FakeCloudMinter
} {
  const minter = (overrides.minter as FakeCloudMinter | undefined) ?? new FakeCloudMinter()
  return {
    minter,
    announce: overrides.announce ?? ((reach) => `acts as ${reach.account}`),
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
    shimDir: overrides.shimDir ?? mkdtempSync(join(tmpdir(), 'roma-shims-')),
    gitConfig: overrides.gitConfig ?? '[credential]\n\tuseHttpPath = true\n',
    announce: overrides.announce ?? ((installation) => `reaches ${installation.repositories.join(', ')}`),
  }
}
