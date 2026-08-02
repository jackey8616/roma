import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceCloud } from './announce.js'
import type { CloudEnv } from './env-config.js'
import { GoogleCloudMinter, type CloudMinter } from './google-cloud-minter.js'

/**
 * What roma says when something asks for a cloud credential and there is no Cloud
 * Reach.
 *
 * A plain sentence rather than a failure, because most deployments have none and
 * that is not a fault (ADR-0015 §9). The Cloud Shortcut is installed on every
 * image either way, so that this is what an agent reads instead of
 * `command not found` — which it would spend a Turn investigating as a broken
 * `PATH`.
 *
 * Here rather than in `shim-server.ts` because it is a sentence about the cloud,
 * and the Core is not allowed to know there is one. The socket reads it off the
 * Reach that carries it (ADR-0020 §2).
 */
export const NO_CLOUD_REACH =
  'This roma has no Cloud Reach, so there is no cloud credential for it to give.'

/**
 * roma's Reach on the cloud, where a deployment has a key for one.
 *
 * No inventory to fetch, so the proof is a mint that is thrown away: what is being
 * proved is that a token can be had at all. A key that is syntactically perfect
 * and revoked is a blind spot no amount of parsing closes, so roma uses the key
 * rather than reading it (ADR-0015 §8).
 */
export function cloudReach(minter: CloudMinter): AvailableReach<'cloud'> {
  return {
    credential: 'cloud',
    minter,

    async prove(): Promise<ReachProof> {
      // Thrown, never turned into the unavailable arm. A revoked key that reported
      // "this deployment has no Cloud Reach" would tell every Session a sentence
      // that is false, and ADR-0015 §8 is explicit that a key that exists and does
      // not work still stops the boot.
      //
      // Refused in `readConfiguration`'s *shape* rather than inside it, which is
      // the gap ADR-0015 §8 records and does not close: that reader is synchronous
      // and this is a network round trip. The wrapping lives here rather than in
      // `startRoma` because how a Reach refuses is the Reach's — the forge's
      // refusals name what they found and are worth more unwrapped.
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

/**
 * The Reach a deployment with no key has: present, and with nothing to give.
 *
 * Not an absence. "There is none" is an answer roma gives out loud rather than a
 * case it has no branch for, and a Reach that were simply missing would read, to
 * whatever consulted it, as one that does not apply.
 */
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
 * The Cloud Reach this deployment configured, or the one it did not.
 *
 * **This function is the whole of ADR-0015 §4 now.** It takes the key
 * `readCloudEnv` read from the path the deployment named, and nothing else — no
 * `GoogleAuth`, no Application Default Credentials, nothing that would go looking
 * for a credential. It is inside `src/cloud/`, which
 * `src/cloud-containment.test.ts` binds against every way of asking a library to
 * find one, and that is why the composition root no longer needs a rule of its
 * own: it never names the constructor, so the substitution cannot be written
 * there. See ADR-0020 §7 before adding a source match back.
 */
export function cloudReachFrom(env: CloudEnv | null): Reach<'cloud'> {
  return env === null ? noCloudReach() : cloudReach(new GoogleCloudMinter(env))
}
