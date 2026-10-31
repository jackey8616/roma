import type { AvailableReach, ReachProof } from '../reach.js'
import { announce } from './announce.js'
import type { MinterEnv } from './env-config.js'
import { GitHubMinter } from './github-minter.js'
import type { Installation, InstallationMinter } from './installation.js'

/** roma's Reach on the forge. */
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

/** The same, built from what a deployment configured: the composition root's entry point. */
export function githubReachFrom(env: MinterEnv): AvailableReach<'code'> {
  return githubReach(new GitHubMinter(env))
}
