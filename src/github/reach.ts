import type { AvailableReach, ReachProof } from '../reach.js'
import { announce } from './announce.js'
import type { MinterEnv } from './env-config.js'
import { GitHubMinter } from './github-minter.js'
import type { Installation, InstallationMinter } from './installation.js'

export function githubReach(minter: InstallationMinter): AvailableReach<'code'> {
  let installation: Installation | null = null

  return {
    credential: 'code',
    minter,

    async prove(): Promise<ReachProof> {
      installation = await minter.installation()
      return { account: installation.account }
    },

    announce(): string {
      if (installation === null) {
        throw new Error('roma announced its Installation before proving it')
      }
      return announce(installation)
    },
  }
}

export function githubReachFrom(env: MinterEnv): AvailableReach<'code'> {
  return githubReach(new GitHubMinter(env))
}
