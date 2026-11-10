import type { MintedToken } from '../reach.js'
import { appJwt } from './app-jwt.js'
import type { Installation, InstallationMinter } from './installation.js'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PER_PAGE = 100

export class InstallationAmbiguous extends Error {
  readonly accounts: readonly string[]

  constructor(accounts: readonly string[]) {
    super(
      [
        `roma refused to start — its GitHub App is installed ${accounts.length} times, and roma ` +
          'acts for exactly one Installation.',
      ]
        .concat(accounts.map((account) => `  ${account}`))
        .join('\n'),
    )
    this.name = 'InstallationAmbiguous'
    this.accounts = accounts
  }
}

export class InstallationMissing extends Error {
  constructor() {
    super(
      'roma refused to start — its GitHub App is installed nowhere, so there is no repository ' +
        'it could reach. Install the App on the repositories roma is meant to work on.',
    )
    this.name = 'InstallationMissing'
  }
}

export class GitHubRefused extends Error {
  readonly status: number

  constructor(what: string, status: number, body: string) {
    super(`GitHub refused ${what} with ${status}: ${body.slice(0, 400)}`)
    this.name = 'GitHubRefused'
    this.status = status
  }
}

export interface GitHubMinterOptions {
  readonly appId: string
  readonly privateKey: string
  readonly api?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export class GitHubMinter implements InstallationMinter {
  readonly #appId: string
  readonly #privateKey: string
  readonly #api: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  #installationId: number | null = null

  constructor({
    appId,
    privateKey,
    api = GITHUB_API,
    fetch = globalThis.fetch,
    now = Date.now,
  }: GitHubMinterOptions) {
    this.#appId = appId
    this.#privateKey = privateKey
    this.#api = api.replace(/\/+$/, '')
    this.#fetch = fetch
    this.#now = now
  }

  async installation(): Promise<Installation> {
    const { id, account } = await this.#onlyInstallation()
    this.#installationId = id
    const { token } = await this.mint()
    return { account, repositories: await this.#repositories(token) }
  }

  async mint(): Promise<MintedToken> {
    const installationId = this.#installationId ?? (await this.#onlyInstallation()).id
    this.#installationId = installationId

    const minted = await this.#asApp<{ token: string; expires_at: string }>(
      `/app/installations/${String(installationId)}/access_tokens`,
      'minting an Installation Token',
      'POST',
    )

    const expiresAt = Date.parse(minted.expires_at)
    return {
      token: minted.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now(),
    }
  }

  async #onlyInstallation(): Promise<{ id: number; account: string }> {
    const installations = await this.#asApp<{ id: number; account: { login?: string } | null }[]>(
      '/app/installations',
      'listing its installations',
    )

    const named = installations.map(
      ({ id, account }) => account?.login ?? `installation ${String(id)}`,
    )
    if (installations.length > 1) throw new InstallationAmbiguous(named)

    const only = installations[0]
    if (only === undefined) throw new InstallationMissing()
    return { id: only.id, account: named[0] ?? '' }
  }

  async #repositories(token: string): Promise<string[]> {
    const found: string[] = []
    for (let page = 1; ; page += 1) {
      const body = await this.#call<{ repositories: { full_name: string }[] }>(
        `/installation/repositories?per_page=${String(PER_PAGE)}&page=${String(page)}`,
        'listing the Installation’s repositories',
        'GET',
        `token ${token}`,
      )
      found.push(...body.repositories.map(({ full_name }) => full_name))
      if (body.repositories.length < PER_PAGE) return found
    }
  }

  async #asApp<T>(path: string, what: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const jwt = appJwt({ appId: this.#appId, privateKey: this.#privateKey, now: this.#now() })
    return await this.#call<T>(path, what, method, `Bearer ${jwt}`)
  }

  async #call<T>(
    path: string,
    what: string,
    method: 'GET' | 'POST',
    authorization: string,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization,
        'x-github-api-version': API_VERSION,
        'user-agent': 'roma',
      },
    })
    if (!response.ok) throw new GitHubRefused(what, response.status, await response.text())
    return (await response.json()) as T
  }
}
