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

const HOUR_MS = 60 * 60_000

export interface FakeMinterOptions {
  readonly installation?: Installation
  readonly failsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

export class FakeMinter implements InstallationMinter {
  readonly minted: MintedToken[] = []
  installations = 0
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
  readonly failsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

export class FakeCloudMinter implements CloudMinter {
  readonly account: string
  readonly minted: MintedToken[] = []
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
  readonly failsWith?: Error
  readonly depotFailsWith?: Error
  readonly lifetimeMs?: number
  readonly now?: () => number
}

export class FakeDocumentMinter implements DocumentMinter {
  readonly account: string
  readonly minted: MintedToken[] = []
  depots = 0
  failsWith: Error | null
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

export function fakeCloudReach(minter: FakeCloudMinter | null): Reach<'cloud'> {
  if (minter === null) return noCloudReach()
  return { ...cloudReach(minter), announce: () => `acts as ${minter.account}` }
}

export function fakeDocumentReach(minter: FakeDocumentMinter | null): Reach<'documents'> {
  if (minter === null) return noDocumentReach()
  return { ...documentReach(minter), announce: () => `writes as ${minter.account}` }
}

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

export function fakeShims(overrides: Partial<ShimsOptions> = {}): ShimsOptions {
  return {
    dir: overrides.dir ?? mkdtempSync(join(tmpdir(), 'roma-shims-')),
    gitConfig: overrides.gitConfig ?? '[credential]\n\tuseHttpPath = true\n',
  }
}

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
