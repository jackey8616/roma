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

  // From `dist/` there is nothing to add, and there must not be: the image is
  // built `--omit=dev` and has no TypeScript loader to ask for.
  it('asks for no loader when the Shim is already JavaScript', () => {
    expect(gitCredentialHelper('/app/dist/github/git-credential-shim.js', '/usr/bin/node')).not.toMatch(
      /--import/,
    )
  })

  // From a checkout it must, and by absolute URL. Node 22 strips the types
  // happily; what it cannot do is resolve the `.js` specifiers the Shim imports
  // by, and `--import` resolves a bare name against git's working directory
  // rather than roma's. Both halves of that were a real from-source failure.
  it('asks for a loader, by absolute URL, when the Shim is TypeScript', () => {
    const helper = gitCredentialHelper('/checkout/src/github/git-credential-shim.ts', '/usr/bin/node')

    expect(helper).toMatch(/--import \/\S*tsx\S*/)
    expect(helper.endsWith(' /checkout/src/github/git-credential-shim.ts')).toBe(true)
  })
})
