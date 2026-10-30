import { SESSION_ID_VAR } from '../shim-protocol.js'
import type { Depot } from './depot.js'

/** The name the image installs the Document Shortcut under. */
export const DOCUMENT_SHORTCUT = 'roma-document-token'

/** The Drive metadata key every file the agent creates is asked to carry. */
export const CONVERSATION_TAG = 'conversation'

/**
 * What every Session is told about the Document Reach: the Shortcut and that
 * re-running it is free, the Depot's id, what may and may not be done there and
 * that the refusal is Google's, the tagging convention, and that the Depot is
 * shared. It states facts and instructs nothing.
 *
 * The tag is the Session id, not the Conversation Key, so a `/clear` moves it.
 */
export function announceDocuments(account: string, depot: Depot): string {
  return [
    'Google Drive access is already configured for this session, by roma. It is for writing the',
    'team’s own documents — a requirements write-up, a backlog — as native Google Docs and Sheets,',
    'which is what a person can comment on, restore an earlier version of, and link to from a ticket.',
    '',
    `- \`${DOCUMENT_SHORTCUT}\` prints an hour-long token on stdout and nothing else, so`,
    `  \`curl -H "Authorization: Bearer $(${DOCUMENT_SHORTCUT})" …\` is the whole of it. Re-running`,
    '  it is free and stateless — ask again rather than reasoning about how much of the hour is left.',
    `- \`${DOCUMENT_SHORTCUT} --json\` gives the same token with its expiry and the account, for the`,
    '  APIs that want you to name the identity you are acting as.',
    `- Everything you do in Drive is done as ${account}.`,
    '',
    `**The Depot** is the one folder you work in: \`${depot.id}\` — “${depot.name}”. Name it as the`,
    'parent of everything you create. In it you may **create** native Docs and Sheets (this',
    'credential covers the Docs API and the Sheets API for files you created), **edit** the ones you',
    'created, and **read** what is there — including anything a person left for you to work from.',
    '',
    'You may **not** move a file out of the Depot, trash one, or delete one. That is **Google’s',
    'answer rather than roma’s**: the identity is a Contributor on the shared drive, and a',
    'Contributor may fill a folder and may not empty one. A refusal on any of those three is the',
    'permission model working — report it as such rather than looking for a way round it. Replacing',
    'a file’s contents *is* an edit and is allowed, so prefer updating a document you created over',
    'creating a second one; Drive keeps the version history either way.',
    '',
    'Tag every file you create with the Conversation it came from:',
    '',
    `    appProperties: { "${CONVERSATION_TAG}": "$${SESSION_ID_VAR}" }`,
    '',
    `\`$${SESSION_ID_VAR}\` is in your environment and names the Conversation you are answering in.`,
    'The tag is invisible in the Drive UI and queryable —',
    `\`q: appProperties has { key='${CONVERSATION_TAG}' and value='…' }\` — so this thread’s earlier`,
    'output is something you can find and update rather than duplicate.',
    '',
    'Everything in the Depot is visible to every Conversation and to everyone who can message roma.',
    'It is one folder for the whole deployment, and it is not private the way your working directory is.',
    '',
    'There is **no Drive CLI installed** and none is coming. Make the calls against Google’s',
    'REST APIs directly; `curl` and Node are in the image, which is all either needs. There is',
    'nothing for you to renew and no key for you to handle: roma holds the key, mints a token when',
    'you ask, and what you are given is worthless within the hour. Put the document’s link in your',
    'answer — it is the only way the person who asked for it finds what you wrote.',
  ].join('\n')
}
