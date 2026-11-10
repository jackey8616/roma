import { describe, expect, it } from 'vitest'
import { allows } from '../egress/allowlist.js'
import { announceDocuments } from './announce.js'
import { DOCUMENT_AGENT_HOSTS } from './egress.js'

const API_HOSTS: Record<string, string> = {
  'Drive API': 'www.googleapis.com',
  'Docs API': 'docs.googleapis.com',
  'Sheets API': 'sheets.googleapis.com',
}

describe('the Document Reach’s hosts', () => {
  it('admit every API the announcement tells the agent it may call [fence:document-reach-reaches-the-apis-it-announces]', () => {
    const announced = announceDocuments('roma@example.iam.gserviceaccount.com', {
      id: 'depot',
      name: 'Depot',
    })
    const named = Object.keys(API_HOSTS).filter(
      (api) => api === 'Drive API' || announced.includes(api),
    )
    expect(named).toEqual(['Drive API', 'Docs API', 'Sheets API'])

    const allowed = allows(DOCUMENT_AGENT_HOSTS)
    for (const api of named) expect(allowed(API_HOSTS[api] ?? ''), api).toBe(true)
  })

  it('admit no other Google API', () => {
    const allowed = allows(DOCUMENT_AGENT_HOSTS)
    for (const host of ['storage.googleapis.com', 'oauth2.googleapis.com', 'pubsub.googleapis.com'])
      expect(allowed(host), host).toBe(false)
  })
})
