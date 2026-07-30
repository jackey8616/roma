import { describe, expect, it } from 'vitest'
import { gitConfig, gitCredentialHelper } from './shims.js'

/**
 * The gitconfig, read as text.
 *
 * Asserted here rather than only through the real-`git` test because the one
 * thing that test cannot see is a setting going missing: a gitconfig without
 * `useHttpPath` still hands out credentials perfectly, and quietly stops
 * recording which repositories a Task reached for.
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
