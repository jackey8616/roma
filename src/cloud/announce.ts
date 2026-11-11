import type { Entitlement } from '../grants.js'

export const CLOUD_SHORTCUT = 'roma-cloud-token'

export const CLOUD_GRANT_SHORTCUT = 'roma-cloud-grant'

export function announceCloud(
  account: string,
  entitlements: readonly Entitlement[] | null = null,
): string {
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
    ...(entitlements === null ? [] : ['', ...announceGrants(entitlements)]),
  ].join('\n')
}

function announceGrants(entitlements: readonly Entitlement[]): string[] {
  return [
    `When those roles are not enough, ${CLOUD_GRANT_SHORTCUT} asks for a Cloud Grant: more roles for a`,
    'while, which a person has to approve in Google Cloud. You can ask for one; you cannot approve one.',
    '',
    `- \`${CLOUD_GRANT_SHORTCUT} request ENTITLEMENT DURATION JUSTIFICATION\` asks. DURATION is like`,
    '  `30m` or `2h`, and Google will not grant less than 30 minutes. JUSTIFICATION is the sentence',
    '  the approver reads: say what the Caller asked for and why it needs this. roma puts the Task',
    '  in front of it.',
    '- It answers with the grant, its state and the page where it is approved. A new one is',
    '  `APPROVAL_AWAITED`: tell the Caller what you asked for, who must approve it and where, and end',
    '  the Turn. Do not wait for it in a loop — the approval is a person, not a process.',
    `- \`${CLOUD_GRANT_SHORTCUT} status GRANT\` says how one stands. Work once it is \`ACTIVE\`; when it`,
    '  ends, the roles go with it.',
    '- While it lasts it widens the Cloud Reach for every Conversation, not only this one, so ask for',
    '  the narrowest entitlement and the shortest time that does the work.',
    '',
    'The entitlements this Cloud Reach may ask for:',
    '',
    ...entitlements.map(described),
  ]
}

function described({ name, roles, conditions, maxDurationS }: Entitlement): string {
  const where = conditions.length === 0 ? '' : `, only where ${conditions.join(' and ')}`
  return `- \`${name}\`: ${roles.join(', ') || 'no roles'}${where}; at most ${hours(maxDurationS)}`
}

function hours(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`
  return `${String(Math.floor(seconds / 60))}m`
}
