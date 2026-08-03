import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceDocuments } from './announce.js'
import type { Depot, DocumentMinter } from './depot.js'
import type { DocumentEnv } from './env-config.js'
import { GoogleDocumentMinter } from './google-document-minter.js'

/**
 * What roma says when something asks for a document credential and there is no
 * Document Reach.
 *
 * A plain sentence rather than a failure, because most deployments have none and
 * that is not a fault (ADR-0015 §9, ADR-0022 §8). The Document Shortcut is
 * installed on every image either way, so that this is what an agent reads
 * instead of `command not found` — which it would spend a Turn investigating as
 * a broken `PATH`.
 *
 * Here rather than in `shim-server.ts` because it is a sentence about documents,
 * and the Core is not allowed to know there is a Drive. The socket reads it off
 * the Reach that carries it (ADR-0020 §2).
 */
export const NO_DOCUMENT_REACH =
  'This roma has no Document Reach, so there is no document credential for it to give.'

/**
 * roma's Reach on the team's documents, where a deployment has a key and a Depot.
 *
 * The proof is three things in one place, any of which blocks the boot: the key
 * mints a token, which is thrown away; the Depot answers; and the answer says
 * this identity can add to it (ADR-0022 §6). The third is new to roma — every
 * other proof it makes says a credential is *live* — and it exists because a
 * Depot named by a typo, a shared drive the account was never added to, and an
 * account added as a Viewer are three different mistakes that would otherwise
 * all surface inside somebody's first Task.
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
      // Thrown, never turned into the unavailable arm. A revoked key that
      // reported "this deployment has no Document Reach" would tell every Session
      // a sentence that is false — ADR-0020 §2 names a `try`/`catch` around this
      // factory as the most natural-looking wrong edit in the file, and it is
      // wrong here for exactly the reason it is wrong there.
      //
      // Two refusals rather than one, because they send an operator to two
      // different places: the first is about a key, and the second is about a
      // folder or a role. Wrapped in `readConfiguration`'s shape so that they
      // read like every other thing wrong with a deployment's configuration.
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
      // Thrown rather than defaulted, for `githubReach`'s reason: the empty
      // version of this announcement names a folder roma never proved, and an
      // agent told to write into one it cannot write to spends a Turn finding
      // that out from a 403.
      if (depot === null) throw new Error('roma announced its Depot before proving it')
      return announceDocuments(minter.account, depot)
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
 * The composition root's entry point, and it is what keeps ADR-0015 §4's rule
 * true for a second Google credential: it takes what `readDocumentEnv` read from
 * the path the deployment named, and nothing else — no `GoogleAuth`, no
 * Application Default Credentials, nothing that would go looking for a
 * credential. It is inside `src/documents/`, which
 * `src/document-containment.test.ts` binds against every way of asking a library
 * to find one, so the substitution cannot be written at the composition root
 * either: that file never names the constructor (ADR-0020 §7).
 */
export function documentReachFrom(env: DocumentEnv | null): Reach<'documents'> {
  return env === null ? noDocumentReach() : documentReach(new GoogleDocumentMinter(env))
}
