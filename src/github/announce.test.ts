import { describe, expect, it } from 'vitest'
import { announce } from './announce.js'

describe('what a Session is told it can reach', () => {
  const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma', 'a-team/infra'] }

  it('names both tools and every repository', () => {
    const said = announce(INSTALLATION)

    expect(said).toContain('`git`')
    expect(said).toContain('`gh`')
    expect(said).toContain('a-team/roma')
    expect(said).toContain('a-team/infra')
  })

  it('says the working directory is empty on purpose', () => {
    expect(announce(INSTALLATION)).toMatch(/empty on purpose/i)
  })

  it('says the work will be attributed to roma rather than to a person', () => {
    expect(announce(INSTALLATION)).toMatch(/not by the person/i)
  })

  it('caps how many it names, and says how many there are [fence:github-announcement-caps-the-advertisement]', () => {
    const why =
      'The announcement names at most 100 repositories, says how many there are, and says ' +
      'the rest are reachable the same way (ADR-0008). It is prepended to every Turn, so the ' +
      'whole list of a large Installation spends the context on a directory; and the cap is ' +
      'on the advertisement, not the access — an agent that reads it as the access refuses ' +
      'work it can do (#62).'
    const many = Array.from({ length: 250 }, (_, at) => `a-team/r${String(at)}`)

    const said = announce({ account: 'a-team', repositories: many })

    expect(said, why).toContain('250 repositories')
    expect(said, why).toMatch(/…and 150 more, all of them reachable/)
    expect(said, why).not.toContain('a-team/r200')
  })

  it('says so plainly when it reaches nothing at all', () => {
    expect(announce({ account: 'a-team', repositories: [] })).toContain('reaches no repositories')
  })
})
