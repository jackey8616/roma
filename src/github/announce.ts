import type { Installation } from '../minter.js'

/**
 * What every Session is told it can reach.
 *
 * Its own file rather than beside the gitconfig in `shims.ts`. The two are
 * edited for different reasons — one changes when the Shim's wiring does, this
 * one changes when what an agent needs to be told does — and a file that holds
 * both is a file with two reasons to change.
 */

/**
 * The most repositories the announcement will name one by one.
 *
 * A cap rather than the whole list, because this text is prepended to every Turn
 * of every Session and an Installation on a thousand repositories would spend
 * more of the context window on a directory than on the work.
 *
 * What is capped is the advertisement, not the access, and the text says so: the
 * count is honest and the last line of the list states that the rest are
 * reachable the same way. An agent asked about the hundred-and-fiftieth
 * repository is therefore told to try, which is the behaviour the capability
 * exists for — the failure this whole text prevents is an agent that refuses
 * work it can do.
 */
const NAMED_AT_MOST = 100

/**
 * A capability nobody knows about is a capability nobody has.
 *
 * Claude Code in an empty directory has no reason to believe it can clone
 * anything, and an agent that explains it has no access instead of trying is the
 * failure this text exists to prevent — so it says the credentials are present,
 * what they reach, and that the working directory is empty on purpose.
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
