import { describe, expect, it } from 'vitest'
import { announceCloud, CLOUD_GRANT_SHORTCUT, CLOUD_SHORTCUT } from './announce.js'

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

describe('announcing what a Cloud Grant may widen', () => {
  const READ = {
    name: 'projects/p1/locations/global/entitlements/read-bucket',
    bindings: [
      { role: 'roles/storage.objectViewer', condition: 'resource.name == "projects/_/buckets/b"' },
    ],
    maxDurationS: 3600,
  }

  it('says nothing about grants where there are none to ask for', () => {
    expect(announceCloud(ACCOUNT)).not.toContain(CLOUD_GRANT_SHORTCUT)
  })

  it('names every entitlement, its roles, where it applies and how long it may last', () => {
    const said = announceCloud(ACCOUNT, [
      READ,
      {
        ...READ,
        name: 'folders/1/locations/global/entitlements/x',
        bindings: [{ role: 'roles/storage.objectAdmin', condition: null }],
        maxDurationS: 5400,
      },
    ])

    expect(said).toContain(
      '`projects/p1/locations/global/entitlements/read-bucket` (at most 1h): roles/storage.objectViewer, only where resource.name == "projects/_/buckets/b"',
    )
    expect(said).toContain(
      '`folders/1/locations/global/entitlements/x` (at most 90m): roles/storage.objectAdmin, with no condition',
    )
  })

  it('says a person approves it, and that the agent cannot [fence:cloud-grant-announced-as-a-request]', () => {
    const said = announceCloud(ACCOUNT, [READ])

    expect(
      said,
      'The agent is told it may ask and may not approve, and to end the Turn rather than poll ' +
        '(ADR-0041 §5). Without it a Turn spins on a person and spends the Shared Window waiting.',
    ).toMatch(/you cannot approve one/i)
    expect(said).toMatch(/end\s+the Turn/)
    expect(said).toMatch(/every Conversation/)
  })
})
