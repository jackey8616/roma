import type { Installation } from './installation.js'

const NAMED_AT_MOST = 100

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
