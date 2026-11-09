import { describe, expect, it } from 'vitest'
import { announceCloud, CLOUD_SHORTCUT } from './announce.js'

const ACCOUNT = 'agent@a-project.iam.gserviceaccount.com'

describe('telling a Session it can reach the cloud', () => {
  it('names the command and what it prints', () => {
    const said = announceCloud(ACCOUNT)

    expect(said).toContain(CLOUD_SHORTCUT)
    expect(said).toContain('--json')
    expect(said).toContain(`$(${CLOUD_SHORTCUT})`)
  })

  it('names the identity the agent acts as', () => {
    expect(announceCloud(ACCOUNT)).toContain('agent@a-project.iam.gserviceaccount.com')
  })

  it('says there is no cloud CLI, so that the agent writes the API call', () => {
    const said = announceCloud(ACCOUNT)

    expect(said).toMatch(/no cloud CLI/i)
    expect(said).toContain('gcloud')
    expect(said).toMatch(/REST API/i)
  })

  it('says there is nothing to renew and no key to handle', () => {
    const said = announceCloud(ACCOUNT)

    expect(said).toMatch(/nothing for you to renew/i)
    expect(said).toMatch(/free and stateless/i)
  })

  it('says the roles are the boundary, and that roma does not know them', () => {
    expect(announceCloud(ACCOUNT)).toMatch(/roles/i)
    expect(announceCloud(ACCOUNT)).toMatch(/roma does not know/i)
  })
})
