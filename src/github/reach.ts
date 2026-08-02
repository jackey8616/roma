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
  // What `prove` found, held for `announce`. The two used to be one expression in
  // `startRoma` — the announcement took the Installation as an argument, so
  // announcing before proving was unspellable. It is spellable now, which is why
  // the throw below exists.
  let installation: Installation | null = null

  return {
    credential: 'code',
    minter,

    async prove(): Promise<ReachProof> {
      // The free check, and the first one roma makes. A bad private key or an App
      // installed twice is found before a single paid Turn has been driven.
      // Failure throws, which blocks the boot: a failure that surfaced instead as
      // an inexplicable `git clone` inside somebody's Turn would read as "roma is
      // broken" with no diagnosis attached.
      installation = await minter.installation()
      return { account: installation.account }
    },

    announce(): string {
      // Thrown rather than defaulted, and this is the reason: `announce` renders
      // an empty repository list as "the App is installed on <account> but
      // reaches no repositories, so a clone will fail until somebody grants it
      // one". An agent told that has been told it has no access when it has all
      // of it, and an agent that explains it has no access instead of trying is
      // the failure that whole text exists to prevent. A wrong order used to be
      // impossible; without this it would be a plausible, wrong sentence.
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
