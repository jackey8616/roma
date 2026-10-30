import type { AvailableReach, ReachProof } from '../reach.js'
import { announce } from './announce.js'
import type { MinterEnv } from './env-config.js'
import { GitHubMinter } from './github-minter.js'
import type { Installation, InstallationMinter } from './installation.js'

/**
 * roma's Reach on the forge: the credential, what it reaches, and what every
 * Session is told about it.
 *
 * Always available and never the other arm — required means required (ADR-0008),
 * and the return type is what says so. There is no development mode that skips
 * the forge credential and now no way to spell one.
 */
export function githubReach(minter: InstallationMinter): AvailableReach<'code'> {
  let installation: Installation | null = null

  return {
    credential: 'code',
    minter,

    async prove(): Promise<ReachProof> {
      // Enforced by `fence:reach-a-broken-key-blocks-the-boot`.
      installation = await minter.installation()
      return { account: installation.account }
    },

    announce(): string {
      // Enforced by `fence:reach-announces-only-what-it-proved`.
      if (installation === null) {
        throw new Error('roma announced its Installation before proving it')
      }
      return announce(installation)
    },
  }
}

/**
 * The same, built from what a deployment configured.
 *
 * The composition root's entry point, so that assembling roma names this
 * directory and not the class inside it.
 */
export function githubReachFrom(env: MinterEnv): AvailableReach<'code'> {
  return githubReach(new GitHubMinter(env))
}
