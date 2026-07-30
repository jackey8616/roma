import { describe, expect, it } from 'vitest'
import { announce } from './announce.js'

/**
 * What a Session is told it can reach, read as text.
 *
 * Load-bearing in a way nothing else would notice was broken: an announcement
 * that omits the repositories produces an agent that politely refuses work it is
 * perfectly able to do, and every test around it still passes.
 */

describe('what a Session is told it can reach', () => {
  const INSTALLATION = { account: 'a-team', repositories: ['a-team/roma', 'a-team/infra'] }

  // A capability nobody knows about is a capability nobody has. Claude Code in
  // an empty directory has no reason to believe it can clone anything.
  it('names both tools and every repository', () => {
    const said = announce(INSTALLATION)

    expect(said).toContain('`git`')
    expect(said).toContain('`gh`')
    expect(said).toContain('a-team/roma')
    expect(said).toContain('a-team/infra')
  })

  // So that the agent does not go looking for a checkout, and does not report
  // the empty directory as roma having failed to set something up.
  it('says the working directory is empty on purpose', () => {
    expect(announce(INSTALLATION)).toMatch(/empty on purpose/i)
  })

  // ADR-0008: every pull request, issue and comment is the App's, and nobody
  // should have to guess whether a human wrote it.
  it('says the work will be attributed to roma rather than to a person', () => {
    expect(announce(INSTALLATION)).toMatch(/not by the person/i)
  })

  // The advertisement is capped, not the access — a thousand-repository
  // Installation would otherwise spend more of every Turn's context on a
  // directory than on the work.
  it('caps how many it names, and says how many there are', () => {
    const many = Array.from({ length: 250 }, (_, at) => `a-team/r${String(at)}`)

    const said = announce({ account: 'a-team', repositories: many })

    expect(said).toContain('250 repositories')
    expect(said).toContain('…and 150 more')
    expect(said).not.toContain('a-team/r200')
  })

  // An App installed on nothing is a real state — somebody installed it and
  // granted no repositories — and an agent told "these repositories:" followed
  // by nothing would invent an explanation for it.
  it('says so plainly when it reaches nothing at all', () => {
    expect(announce({ account: 'a-team', repositories: [] })).toContain('reaches no repositories')
  })
})
