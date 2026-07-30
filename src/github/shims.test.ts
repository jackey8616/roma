import { describe, expect, it } from 'vitest'
import { announce, gitConfig, gitCredentialHelper } from './shims.js'

/**
 * The two pieces of text roma writes down, read as text.
 *
 * They are asserted here rather than only through the things that use them
 * because both are load-bearing in a way nothing would notice was broken: a
 * gitconfig missing `useHttpPath` still works and quietly stops recording which
 * repositories a Task reached for, and an announcement that omits the
 * repositories produces an agent that politely refuses work it can do.
 */

describe('the gitconfig every Session runs under', () => {
  it('puts the Shim in front of git', () => {
    expect(gitConfig('!true')).toContain('helper = !true')
  })

  // Set even though this slice scopes no token to a repository. It is what makes
  // `git` name the repository on every request — measured on git 2.43.0 — and
  // therefore what keeps an Audit Record of repositories reached possible. That
  // record is out of scope; foreclosing it is not.
  it('asks git to name the repository every time it wants a credential', () => {
    expect(gitConfig('!true')).toContain('useHttpPath = true')
  })

  // git's own spelling for "run this command": the Shim is a Node program in
  // roma's build, not an executable called `git-credential-something`.
  it('spells the helper as a command rather than as a bare path', () => {
    expect(gitCredentialHelper('/app/dist/github/git-credential-shim.js', '/usr/bin/node')).toBe(
      '!/usr/bin/node /app/dist/github/git-credential-shim.js',
    )
  })
})

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
