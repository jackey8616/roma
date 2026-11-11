import { ConfigurationMissing } from '../env-config.js'
import type { Grants } from '../grants.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, CloudReach, ReachProof } from '../reach.js'
import { announceCloud } from './announce.js'
import { CLOUD_GRANT_SCOPES_VAR, type CloudEnv } from './env-config.js'
import { GoogleCloudMinter, type CloudMinter } from './google-cloud-minter.js'
import { PamGrants } from './pam.js'

export const NO_CLOUD_REACH =
  'This roma has no Cloud Reach, so there is no cloud credential for it to give.'

export const NO_CLOUD_GRANT_FOR_NO_REACH =
  'This roma has no Cloud Reach, so there is nothing a Cloud Grant could widen.'

export const NO_CLOUD_GRANT_SCOPES =
  `This roma's Cloud Reach is not widened by Cloud Grants: nobody set ${CLOUD_GRANT_SCOPES_VAR}, ` +
  'so it has the roles it was given and no way to ask for more.'

export function cloudReach(
  minter: CloudMinter,
  pam: PamGrants | null = null,
): AvailableReach<'cloud'> & { readonly grants: Grants } {
  return {
    credential: 'cloud',
    minter,
    grants: pam === null ? { unavailable: NO_CLOUD_GRANT_SCOPES } : { requests: pam },

    async prove(): Promise<ReachProof> {
      try {
        await minter.mint()
      } catch (error) {
        throw new ConfigurationMissing([
          `roma could not mint a Cloud Token with the key it was given, so its Cloud Reach ` +
            `(${minter.account}) does not work: ${reasonOf(error)}`,
        ])
      }
      if (pam !== null) {
        try {
          await pam.find()
        } catch (error) {
          throw new ConfigurationMissing([
            `roma could not find what its Cloud Reach (${minter.account}) may request in ` +
              `${pam.scopes.join(', ')}: ${reasonOf(error)}`,
          ])
        }
      }
      return { account: minter.account }
    },

    announce(): string {
      return announceCloud(minter.account, pam === null ? null : pam.entitlements())
    },
  }
}

export function noCloudReach(): CloudReach {
  return {
    credential: 'cloud',
    unavailable: NO_CLOUD_REACH,
    grants: { unavailable: NO_CLOUD_GRANT_FOR_NO_REACH },
    prove: async (): Promise<ReachProof> => ({ account: null }),
    announce: () => '',
  }
}

export function cloudReachFrom(env: CloudEnv | null): CloudReach {
  if (env === null) return noCloudReach()
  const minter = new GoogleCloudMinter(env)
  return cloudReach(
    minter,
    env.grantScopes.length === 0 ? null : new PamGrants({ minter, scopes: env.grantScopes }),
  )
}
