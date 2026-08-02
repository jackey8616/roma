/**
 * What every Session is told about the cloud it can reach.
 *
 * A sibling of `src/github/announce.ts` rather than a paragraph inside it: the
 * two are appended together, but only one of them is always there, and a single
 * function would have to be told about a Cloud Reach it usually does not have.
 * They also change for different reasons.
 */

/** The name the image installs the Cloud Shortcut under. */
export const CLOUD_SHORTCUT = 'roma-cloud-token'

/**
 * A capability nobody knows about is a capability nobody has.
 *
 * `announce.ts`'s first line, and it applies twice over here. Claude Code has no
 * reason to believe it can reach anybody's cloud, and it has every reason to
 * reach for `gcloud` and report that it is missing — so this says the credential
 * is already configured, which identity it acts as, that there is nothing to
 * renew, and that the way to spend it is Google's REST APIs rather than a CLI
 * that is deliberately not installed (ADR-0015 §1).
 *
 * Discovery has to be free, which is why this is in the system prompt at all: a
 * `--help` is a Turn, a Session remembers nothing, and that is a Turn paid once
 * per Session to save Turns.
 *
 * Absent entirely where a deployment has no Cloud Reach — the Reach it has is the
 * unavailable one, whose own announcement is empty — because a paragraph
 * explaining a capability that is not there is worse than silence.
 *
 * Takes the account rather than a Cloud Reach: what it needs is the identity, and
 * a one-field type standing between it and the string was the `ReachProof` shape
 * written twice (ADR-0020).
 */
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
