import { ConfigurationMissing } from '../env-config.js'
import { reasonOf } from '../operator-log.js'
import type { AvailableReach, Reach, ReachProof } from '../reach.js'
import { announceDocuments } from './announce.js'
import type { Depot, DocumentMinter } from './depot.js'
import type { DocumentEnv } from './env-config.js'
import { GoogleDocumentMinter } from './google-document-minter.js'

export const NO_DOCUMENT_REACH =
  'This roma has no Document Reach, so there is no document credential for it to give.'

export function documentReach(minter: DocumentMinter): AvailableReach<'documents'> {
  let depot: Depot | null = null

  return {
    credential: 'documents',
    minter,

    async prove(): Promise<ReachProof> {
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
        throw new ConfigurationMissing([reasonOf(error)])
      }
      return { account: minter.account }
    },

    announce(): string {
      if (depot === null) throw new Error('roma announced its Depot before proving it')
      return announceDocuments(minter.account, depot)
    },
  }
}

export function noDocumentReach(): Reach<'documents'> {
  return {
    credential: 'documents',
    unavailable: NO_DOCUMENT_REACH,
    prove: async (): Promise<ReachProof> => ({ account: null }),
    announce: () => '',
  }
}

export function documentReachFrom(env: DocumentEnv | null): Reach<'documents'> {
  return env === null ? noDocumentReach() : documentReach(new GoogleDocumentMinter(env))
}
