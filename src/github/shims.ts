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

/**
 * The Shim, beside this file, with whatever extension this file has.
 *
 * Two builds have to work and they disagree about the extension: the image runs
 * `dist/github/shims.js` and a developer running from source runs
 * `src/github/shims.ts`. Hard-coding `.js` breaks the second, which ADR-0008
 * names as a consequence it accepts — running roma from source is supposed to
 * work, and a helper that crashes is not it.
 */
function shimBesideThisFile(): string {
  const here = fileURLToPath(import.meta.url)
  return here.replace(/shims\.(m?[jt]s)$/, 'git-credential-shim.$1')
}

/**
 * What has to be in front of the Shim for `node` to be able to load it.
 *
 * Nothing, from `dist/`. From a checkout, a TypeScript loader — and the reason is
 * narrower than "it is TypeScript". Node 22 runs a `.ts` file perfectly well by
 * stripping the types; what it cannot do is resolve the `../shim-client.js` the
 * Shim imports, because that file is `.ts` on disk and rewriting the specifier is
 * not something type-stripping does. Measured, on Node 22.22 and git 2.41: plain
 * `node` on the `.ts` Shim dies with ERR_MODULE_NOT_FOUND, git falls through to
 * asking for a username, and every credential request in a from-source roma fails.
 *
 * Resolved to an absolute path rather than left as the bare name `tsx`.
 * `--import` is resolved against the *current working directory*, and git runs
 * the helper wherever git happens to be — inside the agent's Working Directory,
 * which has no `node_modules` and is not roma's checkout.
 *
 * `createRequire` rather than `import.meta.resolve`, which is the obvious way to
 * ask and is not available under the test runner's module transform — so the
 * obvious way would have been a function that worked everywhere except where it
 * is asserted. Resolution is only attempted on the `.ts` branch, so `dist/` never
 * asks for a development dependency it was built without.
 */
function loaderFor(shim: string): string {
  if (!shim.endsWith('.ts') && !shim.endsWith('.mts')) return ''
  return ` --import ${createRequire(import.meta.url).resolve('tsx')}`
}

/**
 * The command `git` runs when it needs a credential.
 *
 * A `!`-prefixed shell command rather than a bare path, which is git's own
 * spelling for "run this": the Shim is a Node module in roma's build and not an
 * executable named `git-credential-something`, and asking the image to install a
 * shebang wrapper for it would be a second file to keep in step.
 */
export function gitCredentialHelper(
  shim = shimBesideThisFile(),
  node = process.execPath,
): string {
  return `!${node}${loaderFor(shim)} ${shim}`
}

/**
 * The gitconfig every Session's `GIT_CONFIG_GLOBAL` points at.
 *
 * `useHttpPath` is set even though this slice scopes no token to a repository,
 * and that is deliberate. It is what makes `git` name the repository on every
 * credential request — measured, on git 2.43.0, and recorded in ADR-0008's
 * amendment — which is what will let an Audit Record say which repositories a
 * Task reached for. That record is out of scope here; foreclosing it is not.
 */
export function gitConfig(helper = gitCredentialHelper()): string {
  return ['[credential]', `\thelper = ${helper}`, '\tuseHttpPath = true', ''].join('\n')
}
