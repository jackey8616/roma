import type { MintedToken } from '../reach.js'
import { appJwt } from './app-jwt.js'
import type { Installation, InstallationMinter } from './installation.js'

/** Where GitHub's REST API lives, unless a deployment says otherwise. */
const GITHUB_API = 'https://api.github.com'
/** The API version this code was written against. Pinned, as GitHub asks. */
const API_VERSION = '2022-11-28'
/** The most repositories one page will carry. GitHub's maximum. */
const PER_PAGE = 100

/**
 * The App is installed more than once, and roma refuses rather than guesses.
 *
 * Every Installation is named, because the operator's next move is to decide
 * which one roma is for and remove the others — and a refusal that named one at
 * a time would turn that into a sequence of boots, the same way an incomplete
 * configuration would.
 */
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

/** The App is installed nowhere, so there is nothing for roma to reach. */
export class InstallationMissing extends Error {
  constructor() {
    super(
      'roma refused to start — its GitHub App is installed nowhere, so there is no repository ' +
        'it could reach. Install the App on the repositories roma is meant to work on.',
    )
    this.name = 'InstallationMissing'
  }
}

/** GitHub answered, and the answer was not one roma can use. */
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
  /** The App's private key, PEM. Read from a file by `readMinterEnv`. */
  readonly privateKey: string
  readonly api?: string
  /** Injected so that every decision here can be asserted without a network. */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

/**
 * The only thing in roma that holds the App's private key.
 *
 * Everything it does is two documented GitHub calls with a JWT in front of them,
 * and it caches exactly one thing — which Installation roma is acting for, since
 * that is settled at boot and cannot change without a restart. It deliberately
 * does *not* cache tokens: refreshing before expiry, serving concurrent askers
 * from one mint and discarding a rejected token are `FreshTokens`', which
 * is arithmetic rather than product knowledge and is tested against a fake of
 * this.
 *
 * **The private key never leaves this object**, and no credential roma derives
 * from it outlives an hour. A key that reached a Transcript would turn a
 * one-hour exposure into a permanent, indefinitely renewable one, which is worse
 * than the personal access token the whole arrangement exists to avoid.
 *
 * It is **not** out of the agent's reach, and ADR-0008 claims otherwise. The key
 * is a file mounted into the container roma runs in, the agent's Claude Code
 * process is a child of roma's, and they share a uid — so a shell can read it.
 * Nothing here can change that: roma spawning the agent is what puts them in one
 * container. It is the same kind of thing as a Credential Shim — a shape that
 * makes the ordinary path correct, and not a boundary. `docs/github-app-verification.md`
 * records the gap rather than letting the ADR's sentence stand unchallenged.
 *
 * Nothing here has been measured. Every behaviour it relies on — that listing
 * installations works this way, that a minted token clones and pushes, that `gh`
 * authenticates with one — is GitHub's documentation and not this repository's
 * observation. `docs/github-app-verification.md` is the list, and it is honest
 * about being unrun.
 */
export class GitHubMinter implements InstallationMinter {
  readonly #appId: string
  readonly #privateKey: string
  readonly #api: string
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => number

  /** Settled at boot and unchanging thereafter: there is exactly one. */
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

  /**
   * Which Installation roma is acting for, and everything it reaches.
   *
   * Called at boot, before anything that could accept an Ingress Message exists.
   * A failure here blocks the boot, which is the point of asking at all.
   */
  async installation(): Promise<Installation> {
    const { id, account } = await this.#onlyInstallation()
    this.#installationId = id
    // The repository list needs an Installation Token rather than the JWT — the
    // JWT is the App speaking as itself, and `GET /installation/repositories` is
    // a question only an Installation can be asked. So the boot check mints
    // once, which also proves the thing every later request depends on.
    const { token } = await this.mint()
    return { account, repositories: await this.#repositories(token) }
  }

  /** One Installation Token, good for the whole Installation. */
  async mint(): Promise<MintedToken> {
    // Discovered here only for a `mint` that arrived before the boot check,
    // which a running roma never produces — startup asks for the Installation
    // before anything can ask for a token. Here so that the class is correct on
    // its own terms rather than on its caller's ordering.
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
      // A token whose expiry roma cannot read is treated as expiring now, so it
      // is used once and never cached. Better than assuming an hour: the whole
      // protection here is the credential's lifetime, and guessing it long is
      // the one direction that cannot be walked back.
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now(),
    }
  }

  /**
   * The one Installation roma acts for, or a refusal naming what it found.
   *
   * There is no installation id to configure and none to look up by hand: roma
   * lists them, uses the one, and refuses on any other number — because roma
   * refuses rather than guesses. Zero is refused as well as two, though the spec
   * names only the ambiguous case: an App installed nowhere has no id to mint
   * against, so the alternative is booting successfully and failing every
   * credential request for the rest of the deployment's life.
   */
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

  /** Every repository the Installation reaches, following GitHub's paging. */
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

  /** One call authenticated as the App itself, with a JWT signed per request. */
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
