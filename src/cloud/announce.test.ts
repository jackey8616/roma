import { describe, expect, it } from 'vitest'
import { announceCloud, CLOUD_SHORTCUT } from './announce.js'

/**
 * What every Session with a Cloud Reach is told, asserted as text.
 *
 * The text is the feature. Everything ADR-0015 §6 and §7 buy — the Turns not
 * spent rediscovering how to authenticate, the agent attempting the work instead
 * of explaining it cannot — happens because of what these sentences say, so
 * asserting on them is asserting on the thing rather than on a rendering of it.
 */

const REACH = { account: 'agent@a-project.iam.gserviceaccount.com' }

describe('telling a Session it can reach the cloud', () => {
  it('names the command and what it prints', () => {
    const said = announceCloud(REACH)

    expect(said).toContain(CLOUD_SHORTCUT)
    expect(said).toContain('--json')
    expect(said).toContain(`$(${CLOUD_SHORTCUT})`)
  })

  // Which identity is acting is the first thing a person reading a Google Cloud
  // audit log needs, and the agent is the one that has to name it when an API
  // asks.
  it('names the identity the agent acts as', () => {
    expect(announceCloud(REACH)).toContain('agent@a-project.iam.gserviceaccount.com')
  })

  // The live cost ADR-0015 accepted, and the reason this sentence is here: told
  // nothing, an agent reaches for `gcloud`, reports it is missing, and the
  // capability is invisible again. There is no CLI and none is coming.
  it('says there is no cloud CLI, so that the agent writes the API call', () => {
    const said = announceCloud(REACH)

    expect(said).toMatch(/no cloud CLI/i)
    expect(said).toContain('gcloud')
    expect(said).toMatch(/REST API/i)
  })

  // The third of the three things `announce.ts` says, and the one that stops an
  // agent inventing a refresh it does not need: re-running is free and
  // stateless, so there is nothing to renew and no key to handle.
  it('says there is nothing to renew and no key to handle', () => {
    const said = announceCloud(REACH)

    expect(said).toMatch(/nothing for you to renew/i)
    expect(said).toMatch(/free and stateless/i)
  })

  // roma is told which identity to hand over and nothing about what it may do,
  // so a permission error is an answer about the roles. An agent that read it as
  // "roma is broken" would report the wrong thing to the wrong person.
  it('says the roles are the boundary, and that roma does not know them', () => {
    expect(announceCloud(REACH)).toMatch(/roles/i)
    expect(announceCloud(REACH)).toMatch(/roma does not know/i)
  })
})
