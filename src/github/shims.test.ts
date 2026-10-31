import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gitConfig, gitCredentialHelper } from './shims.js'

describe('the gitconfig every Session runs under', () => {
  it('puts the Shim in front of git', () => {
    expect(gitConfig('!true')).toContain('helper = !true')
  })

  it('asks git to name the repository every time it wants a credential', () => {
    expect(gitConfig('!true')).toContain('useHttpPath = true')
  })

  it('spells the helper as a command rather than as a bare path', () => {
    expect(gitCredentialHelper('/app/dist/github/git-credential-shim.js', '/usr/bin/node')).toBe(
      '!/usr/bin/node /app/dist/github/git-credential-shim.js',
    )
  })

  it('asks for no loader when the Shim is already JavaScript', () => {
    expect(
      gitCredentialHelper('/app/dist/github/git-credential-shim.js', '/usr/bin/node'),
    ).not.toMatch(/--import/)
  })

  it('asks for a loader, by absolute URL, when the Shim is TypeScript [fence:github-loader-by-absolute-path]', () => {
    const why =
      'From a checkout the helper loads tsx by absolute path, resolved with `createRequire` ' +
      '(ADR-0008). Node 22 cannot resolve the `.js` specifiers the Shim imports by; `--import` ' +
      "resolves a bare `tsx` against git's working directory, the agent's, which has no " +
      '`node_modules`; and `import.meta.resolve` is unavailable under the test transform. ' +
      'Each makes every from-source credential request fail (#62).'
    const helper = gitCredentialHelper(
      '/checkout/src/github/git-credential-shim.ts',
      '/usr/bin/node',
    )

    expect(helper, why).toMatch(/--import \/\S*tsx\S*/)
    expect(helper.endsWith(' /checkout/src/github/git-credential-shim.ts'), why).toBe(true)
  })

  it('finds the Shim beside itself, with its own extension [fence:github-shim-beside-this-file]', () => {
    const shim = gitCredentialHelper().split(' ').at(-1) ?? ''

    expect(
      existsSync(shim) && shim.endsWith('git-credential-shim.ts'),
      'The Shim is found beside shims.ts with whatever extension shims.ts has, never a ' +
        'hard-coded `.js` (ADR-0008). The image runs `dist/github/shims.js` and a developer runs ' +
        '`src/github/shims.ts`; hard-coded, a from-source roma names a Shim that is not there ' +
        `and every credential request fails. Named: ${shim} (#62).`,
    ).toBe(true)
  })
})
