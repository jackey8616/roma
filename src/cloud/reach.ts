import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceCloud } from './announce.js'
import type { CloudEnv } from './env-config.js'
import { GoogleCloudMinter, type CloudMinter } from './google-cloud-minter.js'

/** What roma says when something asks for a cloud credential and there is no Cloud Reach. */
export const NO_CLOUD_REACH =
  'This roma has no Cloud Reach, so there is no cloud credential for it to give.'

/**
 * roma's Reach on the cloud, where a deployment has a key for one. Its proof is
 * a mint that is thrown away: a revoked key fails it however well it parses.
 */
export function cloudReach(minter: CloudMinter): AvailableReach<'cloud'> {
  return {
    credential: 'cloud',
    minter,

    async prove(): Promise<ReachProof> {
      // Enforced by `fence:reach-a-broken-key-blocks-the-boot`.
      try {
        await minter.mint()
      } catch (error) {
        throw new ConfigurationMissing([
          `roma could not mint a Cloud Token with the key it was given, so its Cloud Reach ` +
            `(${minter.account}) does not work: ${reasonOf(error)}`,
        ])
      }
      return { account: minter.account }
    },

    announce(): string {
      return announceCloud(minter.account)
    },
  }
}

/** The Reach a deployment with no key has: present, and with nothing to give. */
export function noCloudReach(): Reach<'cloud'> {
  return {
    credential: 'cloud',
    unavailable: NO_CLOUD_REACH,
    prove: async (): Promise<ReachProof> => ({ account: null }),
    // Nothing, rather than a paragraph explaining a capability that is not there.
    // Filtered out before the announcements are joined.
    announce: () => '',
  }
}

/**
 * The Cloud Reach this deployment configured, or the one it did not. Takes the
 * key `readCloudEnv` read, and nothing else. Enforced by
 * `fence:cloud-never-resolves-a-credential`.
 */
export function cloudReachFrom(env: CloudEnv | null): Reach<'cloud'> {
  return env === null ? noCloudReach() : cloudReach(new GoogleCloudMinter(env))
}
