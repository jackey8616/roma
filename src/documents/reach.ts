import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceDocuments } from './announce.js'
import type { Depot, DocumentMinter } from './depot.js'
import type { DocumentEnv } from './env-config.js'
import { GoogleDocumentMinter } from './google-document-minter.js'

/**
 * What roma says when something asks for a document credential and there is no
 * Document Reach: a sentence, not a failure.
 */
export const NO_DOCUMENT_REACH =
  'This roma has no Document Reach, so there is no document credential for it to give.'

/**
 * roma's Reach on the team's documents, where a deployment has a key and a Depot.
 * Its proof throws `ConfigurationMissing`, blocking the boot, unless the key
 * mints a token, the Depot answers, and the answer says this identity can add to
 * it. `announce` throws if called before the proof succeeded.
 */
export function documentReach(minter: DocumentMinter): AvailableReach<'documents'> {
  // What `prove` found, held for `announce`. The Depot's id is in the
  // announcement, and an announcement built before the proof would be naming a
  // folder roma has not established it can write to.
  let depot: Depot | null = null

  return {
    credential: 'documents',
    minter,

    async prove(): Promise<ReachProof> {
      // Enforced by `fence:reach-a-broken-key-blocks-the-boot`.
      try {
        await minter.mint()
      } catch (error) {
        throw new ConfigurationMissing([
          `roma could not mint a Document Token with the key it was given, so its Document Reach ` +
            `(${minter.account}) does not work: ${reasonOf(error)}`,
        ])
      }
      try {
        depot = await minter.depot()
      } catch (error) {
        // The Minter's own sentence, unwrapped: it is the one that knows which of
        // the three things is wrong, and paraphrasing it here would flatten them
        // back into one.
        throw new ConfigurationMissing([reasonOf(error)])
      }
      return { account: minter.account }
    },

    announce(): string {
      // Enforced by `fence:reach-announces-only-what-it-proved`.
      if (depot === null) throw new Error('roma announced its Depot before proving it')
      return announceDocuments(minter.account, depot)
    },
  }
}

/** The Reach a deployment with no key has: present, and with nothing to give. */
export function noDocumentReach(): Reach<'documents'> {
  return {
    credential: 'documents',
    unavailable: NO_DOCUMENT_REACH,
    prove: async (): Promise<ReachProof> => ({ account: null }),
    // Nothing, rather than a paragraph explaining a capability that is not there.
    // Filtered out before the announcements are joined.
    announce: () => '',
  }
}

/**
 * The Document Reach this deployment configured, or the one it did not.
 *
 * The composition root's entry point: it takes what `readDocumentEnv` read from
 * the path the deployment named, and nothing else.
 * Enforced by `fence:documents-never-resolves-a-credential`.
 */
export function documentReachFrom(env: DocumentEnv | null): Reach<'documents'> {
  return env === null ? noDocumentReach() : documentReach(new GoogleDocumentMinter(env))
}
