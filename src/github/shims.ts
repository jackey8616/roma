import { fileURLToPath } from 'node:url'
import type { Installation } from '../minter.js'

/**
 * The two things roma has to say out loud for a Credential Shim to be reached at
 * all: the gitconfig that puts one in front of `git`, and the sentence that
 * tells the agent any of this exists.
 *
 * Under `src/github/` because both name the product — `x-access-token` is
 * GitHub's username for an Installation Token, and `gh` is GitHub's CLI. The
 * Core takes what these produce as text and knows nothing about what is in it.
 */

/**
 * The command `git` runs when it needs a credential.
 *
 * A `!`-prefixed shell command rather than a bare path, which is git's own
 * spelling for "run this": the Shim is a Node program in roma's build and not an
 * executable named `git-credential-something`, and asking the image to install a
 * shebang wrapper for it would be a second file to keep in step.
 */
export function gitCredentialHelper(
  shim = fileURLToPath(new URL('./git-credential-shim.js', import.meta.url)),
  node = process.execPath,
): string {
  return `!${node} ${shim}`
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

/**
 * The most repositories the announcement will name one by one.
 *
 * A cap rather than the whole list, because this text is prepended to every Turn
 * of every Session and an Installation on a thousand repositories would spend
 * more of the context window on a directory than on the work. The count is still
 * told the truth, and the credential reaches all of them regardless — what is
 * capped is the advertisement, not the access.
 */
const NAMED_AT_MOST = 100

/**
 * What every Session is told about what it can reach.
 *
 * A capability nobody knows about is a capability nobody has. Claude Code in an
 * empty directory has no reason to believe it can clone anything, and an agent
 * that explains it has no access instead of trying is the failure this text
 * exists to prevent — so it says the credentials are present, what they reach,
 * and that the working directory is empty on purpose.
 *
 * That the list goes stale if the App is installed somewhere new is accepted,
 * and it goes stale softly: the token already covers the new repository, so
 * cloning it works. Only the advertisement is behind, and only until the next
 * restart.
 */
export function announce(installation: Installation): string {
  const { account, repositories } = installation
  const named = repositories.slice(0, NAMED_AT_MOST)
  const rest = repositories.length - named.length

  return [
    'GitHub access is already configured for this session, by roma:',
    '',
    '- `git` has a credential helper, so cloning, fetching and pushing over HTTPS work with',
    '  no setup. Use `https://github.com/<owner>/<repo>.git` — do not try SSH, and do not put',
    '  a token in a URL.',
    '- `gh` is authenticated, so issues, pull requests, reviews and comments are available.',
    '- Everything you do on GitHub is authored by roma’s GitHub App, not by the person who',
    '  asked. It is visibly a bot, which is intended.',
    '',
    repositories.length === 0
      ? `The App is installed on ${account} but reaches no repositories, so a clone will fail ` +
        'until somebody grants it one.'
      : `They reach these ${String(repositories.length)} repositories on ${account}, and only ` +
        'these:',
    ...named.map((repository) => `- ${repository}`),
    ...(rest > 0 ? [`- …and ${String(rest)} more, all of them reachable the same way.`] : []),
    '',
    'This working directory is empty on purpose: roma checks nothing out, so clone whatever',
    'you have been asked about. Credentials are minted when a tool asks for one and roma keeps',
    'them fresh, so a long conversation does not lose access — there is nothing to renew and',
    'no token for you to handle.',
  ].join('\n')
}
