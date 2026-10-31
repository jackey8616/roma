import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceCloud } from './announce.js'
import type { CloudEnv } from './env-config.js'
import { GoogleCloudMinter, type CloudMinter } from './google-cloud-minter.js'

export const NO_CLOUD_REACH =
  'This roma has no Cloud Reach, so there is no cloud credential for it to give.'

export function cloudReach(minter: CloudMinter): AvailableReach<'cloud'> {
  return {
    credential: 'cloud',
    minter,

    async prove(): Promise<ReachProof> {
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

export function noCloudReach(): Reach<'cloud'> {
  return {
    credential: 'cloud',
    unavailable: NO_CLOUD_REACH,
    prove: async (): Promise<ReachProof> => ({ account: null }),
    announce: () => '',
  }
}

export function cloudReachFrom(env: CloudEnv | null): Reach<'cloud'> {
  return env === null ? noCloudReach() : cloudReach(new GoogleCloudMinter(env))
}
