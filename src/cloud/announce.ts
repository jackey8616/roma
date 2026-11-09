export const CLOUD_SHORTCUT = 'roma-cloud-token'

export function announceCloud(account: string): string {
  return [
    'Google Cloud access is already configured for this session, by roma:',
    '',
    `- \`${CLOUD_SHORTCUT}\` prints an hour-long token on stdout and nothing else, so`,
    `  \`curl -H "Authorization: Bearer $(${CLOUD_SHORTCUT})" …\` is the whole of it. Re-running it`,
    '  is free and stateless — ask again rather than reasoning about how much of the hour is left.',
    `- \`${CLOUD_SHORTCUT} --json\` gives the same token with its expiry and the account, for the`,
    '  APIs that want you to name the identity you are acting as.',
    `- Everything you do in Google Cloud is done as ${account}, and the roles somebody granted`,
    '  that account are the whole of what you can touch. roma does not know what those are, so',
    '  a permission error is an answer about the roles and not about roma.',
    '',
    'There is **no cloud CLI installed** — no `gcloud`, and none is coming. Make the calls against',
    'Google’s REST APIs directly; `curl` and Node are in the image, which is all either needs.',
    'There is nothing for you to renew and no key for you to handle: roma holds the key, mints a',
    'token when you ask, and what you are given is worthless within the hour.',
  ].join('\n')
}
