import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * What roma has to write down for the `git` Credential Shim to be reached at
 * all: a gitconfig naming it, and the command that runs it.
 *
 * Under `src/github/` because it names the product — `x-access-token` is
 * GitHub's username for an Installation Token. The Core takes what this produces
 * as text and knows nothing about what is in it.
 */

/** Enforced by `fence:github-shim-beside-this-file`. */
function shimBesideThisFile(): string {
  const here = fileURLToPath(import.meta.url)
  return here.replace(/shims\.(m?[jt]s)$/, 'git-credential-shim.$1')
}

/** Enforced by `fence:github-loader-by-absolute-path`. */
function loaderFor(shim: string): string {
  if (!shim.endsWith('.ts') && !shim.endsWith('.mts')) return ''
  return ` --import ${createRequire(import.meta.url).resolve('tsx')}`
}

/** The command `git` runs when it needs a credential. */
export function gitCredentialHelper(shim = shimBesideThisFile(), node = process.execPath): string {
  return `!${node}${loaderFor(shim)} ${shim}`
}

/** The gitconfig every Session's `GIT_CONFIG_GLOBAL` points at. */
export function gitConfig(helper = gitCredentialHelper()): string {
  return ['[credential]', `\thelper = ${helper}`, '\tuseHttpPath = true', ''].join('\n')
}
