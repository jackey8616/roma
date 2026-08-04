import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GitHubMinter,
  GitHubRefused,
  InstallationAmbiguous,
  InstallationMissing,
} from './github-minter.js'

/**
 * The Minter, against a fake of GitHub's HTTP surface.
 *
 * `fetch` is the seam, which is the narrowest one available: everything above it
 * — the JWT, which endpoints are called and in what order, the refusals, the
 * paging — is roma's, and everything below it is a network this test must not
 * touch and CI must not have a key for.
 *
 * What it cannot assert, and does not pretend to: that GitHub actually behaves
 * this way. Every response here is written from documentation, and
 * `docs/github-app-verification.md` is the list of what only a real App can
 * settle.
 */

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()

const API = 'https://api.example.test'
const EXPIRES_AT = '2026-07-30T13:00:00Z'

interface Call {
  readonly url: string
  readonly method: string
  readonly authorization: string
}

/** A GitHub that answers from a script, and records what it was asked. */
function githubAnswering(
  replies: Record<string, () => { status?: number; body: unknown }>,
  now?: () => number,
) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input).slice(API.length)
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
    })
    const reply = replies[url.split('?')[0] ?? url]
    if (reply === undefined) throw new Error(`nothing is scripted for ${url}`)
    const { status = 200, body } = reply()
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'text/json' } }),
    )
  }
  return {
    calls,
    minter: new GitHubMinter({
      appId: '12345',
      privateKey: PEM,
      api: API,
      fetch,
      ...(now === undefined ? {} : { now }),
    }),
  }
}

const ONE_INSTALLATION = () => ({ body: [{ id: 42, account: { login: 'a-team' } }] })
const A_TOKEN = () => ({ body: { token: 'ghs_a-token', expires_at: EXPIRES_AT } })
const TWO_REPOSITORIES = () => ({
  body: { repositories: [{ full_name: 'a-team/roma' }, { full_name: 'a-team/infra' }] },
})

describe('finding the Installation at boot', () => {
  it('reports the account and every repository it reaches', async () => {
    const { minter } = githubAnswering({
      '/app/installations': ONE_INSTALLATION,
      '/app/installations/42/access_tokens': A_TOKEN,
      '/installation/repositories': TWO_REPOSITORIES,
    })

    expect(await minter.installation()).toEqual({
      account: 'a-team',
      repositories: ['a-team/roma', 'a-team/infra'],
    })
  })

  // No installation id variable, deliberately: there is nothing for an operator
  // to look up and copy, and therefore nothing to get wrong.
  it('mints against the Installation it found, with no id configured', async () => {
    const { minter, calls } = githubAnswering({
      '/app/installations': ONE_INSTALLATION,
      '/app/installations/42/access_tokens': A_TOKEN,
      '/installation/repositories': TWO_REPOSITORIES,
    })
    await minter.installation()

    await minter.mint()

    expect(calls.filter(({ method }) => method === 'POST').map(({ url }) => url)).toEqual([
      '/app/installations/42/access_tokens',
      '/app/installations/42/access_tokens',
    ])
  })

  // roma refuses rather than guesses. Every Installation is named, because the
  // operator's next move is to decide which one roma is for.
  it('refuses when the App is installed more than once, naming all of them', async () => {
    const { minter } = githubAnswering({
      '/app/installations': () => ({
        body: [
          { id: 1, account: { login: 'a-team' } },
          { id: 2, account: { login: 'another-team' } },
        ],
      }),
    })

    await expect(minter.installation()).rejects.toThrow(InstallationAmbiguous)
    await expect(minter.installation()).rejects.toThrow(/a-team[\s\S]*another-team/)
  })

  it('refuses when the App is installed nowhere', async () => {
    const { minter } = githubAnswering({ '/app/installations': () => ({ body: [] }) })

    await expect(minter.installation()).rejects.toThrow(InstallationMissing)
  })

  // A bad private key surfacing here rather than as an inexplicable `git clone`
  // failure inside somebody's Turn is the whole reason the boot asks at all.
  it('carries GitHub’s refusal, with what was being attempted', async () => {
    const { minter } = githubAnswering({
      '/app/installations': () => ({
        status: 401,
        body: { message: 'A JWT could not be decoded' },
      }),
    })

    await expect(minter.installation()).rejects.toThrow(GitHubRefused)
    await expect(minter.installation()).rejects.toThrow(/listing its installations.*401/s)
  })

  // The repository list is a question only an Installation can be asked, so the
  // boot check mints once — which also proves the thing every later request
  // depends on.
  it('reads the repositories with an Installation Token, not the App’s JWT', async () => {
    const { minter, calls } = githubAnswering({
      '/app/installations': ONE_INSTALLATION,
      '/app/installations/42/access_tokens': A_TOKEN,
      '/installation/repositories': TWO_REPOSITORIES,
    })

    await minter.installation()

    expect(calls.at(0)?.authorization).toMatch(/^Bearer ey/)
    expect(calls.at(-1)?.authorization).toBe('token ghs_a-token')
  })

  it('follows the paging rather than stopping at the first hundred', async () => {
    let page = 0
    const { minter } = githubAnswering({
      '/app/installations': ONE_INSTALLATION,
      '/app/installations/42/access_tokens': A_TOKEN,
      '/installation/repositories': () => {
        page += 1
        return {
          body: {
            repositories:
              page === 1
                ? Array.from({ length: 100 }, (_, at) => ({ full_name: `a-team/r${String(at)}` }))
                : [{ full_name: 'a-team/last' }],
          },
        }
      },
    })

    const { repositories } = await minter.installation()

    expect(repositories).toHaveLength(101)
    expect(repositories.at(-1)).toBe('a-team/last')
  })
})

describe('minting an Installation Token', () => {
  it('reports the token and when the forge says it dies', async () => {
    const { minter } = githubAnswering({
      '/app/installations': ONE_INSTALLATION,
      '/app/installations/42/access_tokens': A_TOKEN,
      '/installation/repositories': TWO_REPOSITORIES,
    })
    await minter.installation()

    expect(await minter.mint()).toEqual({
      token: 'ghs_a-token',
      expiresAt: Date.parse(EXPIRES_AT),
    })
  })

  // Guessing an hour is the one direction that cannot be walked back: the whole
  // protection here is the credential's lifetime, and a token roma believes in
  // for longer than it is good for is exactly what the caching must not produce.
  it('treats a token with an unreadable expiry as already spent', async () => {
    const now = Date.parse('2026-07-30T12:00:00Z')
    const { minter } = githubAnswering(
      {
        '/app/installations': ONE_INSTALLATION,
        '/app/installations/42/access_tokens': () => ({
          body: { token: 'ghs_a-token', expires_at: 'whenever' },
        }),
        '/installation/repositories': TWO_REPOSITORIES,
      },
      () => now,
    )
    await minter.installation()

    expect((await minter.mint()).expiresAt).toBe(now)
  })
})
