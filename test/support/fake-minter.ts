import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudMinter } from '../../src/cloud/google-cloud-minter.js'
import { cloudReach, noCloudReach, NO_CLOUD_REACH } from '../../src/cloud/reach.js'
import { FreshTokens } from '../../src/fresh-tokens.js'
import type { Installation, InstallationMinter } from '../../src/github/installation.js'
import type { AvailableReach, MintedToken, Reach, Reaches } from '../../src/reach.js'
import type { ServedReaches } from '../../src/shim-server.js'
import type { ShimsOptions } from '../../src/startup.js'

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
export class FakeMinter implements InstallationMinter {
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

/**
 * roma's Reach on the forge, with a fake announcement and nothing real.
 *
 * Built here rather than by `githubReach` because these tests are about the boot,
 * the socket and the ordering — not about the paragraph an agent reads. A short
 * announcement is what makes `--append-system-prompt` assertable at all.
 */
export function fakeCodeReach(minter: FakeMinter = new FakeMinter()): AvailableReach<'code'> {
  let installation: Installation | null = null
  return {
    credential: 'code',
    minter,
    prove: async () => {
      installation = await minter.installation()
      return { account: installation.account }
    },
    announce: () => {
      if (installation === null) throw new Error('announced before proving')
      return `reaches ${installation.repositories.join(', ')}`
    },
  }
}

/**
 * roma's Reach on the cloud, or the one a deployment without a key has.
 *
 * Null gives the real unavailable Reach rather than a stand-in, because the
 * sentence it carries is what several tests assert against.
 */
export function fakeCloudReach(minter: FakeCloudMinter | null): Reach<'cloud'> {
  if (minter === null) return noCloudReach()
  // The real Reach, with only the announcement swapped. How it proves and how it
  // refuses are what these tests are about, and a fixture that reimplemented
  // either would be asserting itself.
  return { ...cloudReach(minter), announce: () => `acts as ${minter.account}` }
}

/** One Reach per credential, with nothing real behind either. */
export function fakeReaches({
  minter = new FakeMinter(),
  cloudMinter = null,
}: {
  readonly minter?: FakeMinter
  readonly cloudMinter?: FakeCloudMinter | null
} = {}): Reaches {
  return { code: fakeCodeReach(minter), cloud: fakeCloudReach(cloudMinter) }
}

/**
 * roma's own directory, as `startRoma` wants it.
 *
 * A throwaway of its own rather than anything under the test's work root, which
 * is the same separation the real thing keeps: a socket under a tree that gets
 * reclaimed is every credential request failing at once.
 */
export function fakeShims(overrides: Partial<ShimsOptions> = {}): ShimsOptions {
  return {
    dir: overrides.dir ?? mkdtempSync(join(tmpdir(), 'roma-shims-')),
    gitConfig: overrides.gitConfig ?? '[credential]\n\tuseHttpPath = true\n',
  }
}

/**
 * What the socket serves, with nothing real behind either Reach.
 *
 * `startRoma` builds this from the Reaches it proved; a test that is about the
 * socket rather than about the boot builds it directly. No cloud minter gives the
 * unavailable arm carrying roma's real sentence, because what several of those
 * tests assert is exactly that sentence.
 */
export function fakeServedReaches({
  minter = new FakeMinter(),
  cloudMinter = null,
  account = 'a-team',
}: {
  readonly minter?: FakeMinter
  readonly cloudMinter?: FakeCloudMinter | null
  readonly account?: string | null
} = {}): ServedReaches {
  return {
    code: { tokens: new FreshTokens({ minter }), account },
    cloud:
      cloudMinter === null
        ? { unavailable: NO_CLOUD_REACH }
        : { tokens: new FreshTokens({ minter: cloudMinter }), account: cloudMinter.account },
  }
}
