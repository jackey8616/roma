import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudMinter } from '../../src/cloud/google-cloud-minter.js'
import { cloudReach, noCloudReach, NO_CLOUD_REACH } from '../../src/cloud/reach.js'
import type { Depot, DocumentMinter } from '../../src/documents/depot.js'
import { documentReach, noDocumentReach, NO_DOCUMENT_REACH } from '../../src/documents/reach.js'
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

export interface FakeDocumentMinterOptions {
  readonly account?: string
  readonly depot?: Depot
  /** What every mint fails with, where minting is meant to fail. */
  readonly failsWith?: Error
  /** What reaching the Depot fails with. The boot proof's second half. */
  readonly depotFailsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

/**
 * A Document Reach with no Drive behind it.
 *
 * The third of these, and the first with two things to prove: the key mints, and
 * the Depot answers that this identity may add to it. Both can fail
 * independently and a test needs to say which, because the whole point of the
 * second half of that proof is that a typo'd folder id and a Viewer role are
 * different mistakes (ADR-0022 §6).
 *
 * Tokens are `document-token-1`, `document-token-2`, deliberately unlike the
 * other two fakes': every test asserting that a documents request was not
 * answered with a Cloud Token rests on telling them apart at a glance.
 */
export class FakeDocumentMinter implements DocumentMinter {
  readonly account: string
  /** Every token this has produced, in order. */
  readonly minted: MintedToken[] = []
  /** How many times the Depot has been asked about. */
  depots = 0
  /** Set to make the next mint, and every mint after it, fail. */
  failsWith: Error | null
  /** Set to make the Depot unreachable, the way a real refusal would. */
  depotFailsWith: Error | null

  readonly #depot: Depot
  readonly #lifetimeMs: number
  readonly #now: () => number

  constructor({
    account = 'writer@a-project.iam.gserviceaccount.com',
    depot = { id: 'FOLDER_ID', name: 'Team documents' },
    failsWith,
    depotFailsWith,
    lifetimeMs = HOUR_MS,
    now = Date.now,
  }: FakeDocumentMinterOptions = {}) {
    this.account = account
    this.#depot = depot
    this.failsWith = failsWith ?? null
    this.depotFailsWith = depotFailsWith ?? null
    this.#lifetimeMs = lifetimeMs
    this.#now = now
  }

  mint(): Promise<MintedToken> {
    if (this.failsWith !== null) return Promise.reject(this.failsWith)
    const minted: MintedToken = {
      token: `document-token-${String(this.minted.length + 1)}`,
      expiresAt: this.#now() + this.#lifetimeMs,
    }
    this.minted.push(minted)
    return Promise.resolve(minted)
  }

  depot(): Promise<Depot> {
    this.depots += 1
    if (this.depotFailsWith !== null) return Promise.reject(this.depotFailsWith)
    if (this.failsWith !== null) return Promise.reject(this.failsWith)
    return Promise.resolve(this.#depot)
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

/**
 * roma's Reach on the team's documents, or the one a deployment without a key
 * has.
 *
 * Null gives the real unavailable Reach rather than a stand-in, because the
 * sentence it carries is what several tests assert against.
 */
export function fakeDocumentReach(minter: FakeDocumentMinter | null): Reach<'documents'> {
  if (minter === null) return noDocumentReach()
  // The real Reach, with only the announcement swapped. How it proves — both
  // halves of it — and how it refuses are what these tests are about, and a
  // fixture that reimplemented either would be asserting itself.
  return { ...documentReach(minter), announce: () => `writes as ${minter.account}` }
}

/** One Reach per credential, with nothing real behind any of them. */
export function fakeReaches({
  minter = new FakeMinter(),
  cloudMinter = null,
  documentMinter = null,
}: {
  readonly minter?: FakeMinter
  readonly cloudMinter?: FakeCloudMinter | null
  readonly documentMinter?: FakeDocumentMinter | null
} = {}): Reaches {
  return {
    code: fakeCodeReach(minter),
    cloud: fakeCloudReach(cloudMinter),
    documents: fakeDocumentReach(documentMinter),
  }
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
 * What the socket serves, with nothing real behind any Reach.
 *
 * `startRoma` builds this from the Reaches it proved; a test that is about the
 * socket rather than about the boot builds it directly. A minter left out gives
 * the unavailable arm carrying roma's real sentence, because what several of
 * those tests assert is exactly that sentence.
 */
export function fakeServedReaches({
  minter = new FakeMinter(),
  cloudMinter = null,
  documentMinter = null,
  account = 'a-team',
}: {
  readonly minter?: FakeMinter
  readonly cloudMinter?: FakeCloudMinter | null
  readonly documentMinter?: FakeDocumentMinter | null
  readonly account?: string | null
} = {}): ServedReaches {
  return {
    code: { tokens: new FreshTokens({ minter }), account },
    cloud:
      cloudMinter === null
        ? { unavailable: NO_CLOUD_REACH }
        : { tokens: new FreshTokens({ minter: cloudMinter }), account: cloudMinter.account },
    documents:
      documentMinter === null
        ? { unavailable: NO_DOCUMENT_REACH }
        : { tokens: new FreshTokens({ minter: documentMinter }), account: documentMinter.account },
  }
}
