import { SESSION_ID_VAR } from '../shim-protocol.js'
import type { Depot } from './depot.js'

/**
 * What every Session is told about the documents it can reach.
 *
 * A sibling of `src/cloud/announce.ts` rather than a paragraph inside it, for
 * the reason that one is a sibling of the forge's: they are appended together,
 * only one of the three is always there, and they change for different reasons.
 * The two Google ones are the pair most likely to be fused by somebody tidying,
 * and ADR-0022 §1 is where that is refused — the Cloud Reach's announcement says
 * *the roles are the whole of what you can touch*, and that sentence is false
 * for Drive, whose boundary is who pressed Share.
 */

/** The name the image installs the Document Shortcut under. */
export const DOCUMENT_SHORTCUT = 'roma-document-token'

/** The Drive metadata key every file the agent creates is asked to carry (ADR-0022 §7). */
export const CONVERSATION_TAG = 'conversation'

/**
 * A capability nobody knows about is a capability nobody has.
 *
 * `announce.ts`'s first line, and the reason this is in the system prompt rather
 * than behind a `--help`: a Session remembers nothing, so discovery would be a
 * Turn paid over and over out of a window somebody else is waiting on.
 *
 * Five things, and the last two are the ones an agent could not guess:
 *
 * - the Shortcut, and that re-running it is free (stories 37, 38);
 * - the Depot's id, so no Turn is spent asking which folder (story 34);
 * - what may be done there, and what may not — **and that the refusal is
 *   Google's rather than roma's**, so that a 403 on a trash is reported as the
 *   permission model working rather than as roma being broken (stories 35, 36);
 * - the tagging convention, so a thread's earlier output is findable rather than
 *   duplicated (story 41);
 * - and one sentence of fact: the Depot is shared. Every other place roma has
 *   ever given the agent is private — a Working Directory is one per Session and
 *   seen by nobody — so an agent that has learned roma's places are private will
 *   assume this one is too (ADR-0022 §10).
 *
 * **That last sentence states and does not instruct.** Not "so do not put
 * anything sensitive there": roma cannot know what a deployment considers
 * sensitive, and a guessed policy is worse than none because it reads as a
 * control while controlling nothing. `announceCloud` already keeps this line —
 * *"a permission error is an answer about the roles and not about roma"*.
 *
 * **The tag is the Session id, and ADR-0022 §7 asks for the Conversation Key.**
 * The difference is what roma actually puts in front of the agent: a Session's
 * environment carries `ROMA_SESSION_ID` and nothing that names the Conversation,
 * and giving it one would mean threading the key through the Session Pool — a
 * Core change, which that record's own Consequences say this feature does not
 * make. What §7 wants survives it. A Session id is a pure function of the
 * Conversation Key and the Session Generation, so a Conversation's whole history
 * of ids is computable from the key without asking Drive anything, and the
 * per-Conversation narrowing (#124) that the convention exists to keep buildable
 * can still attribute an old file to the thread that produced it. What is lost
 * is smaller and worth saying out loud: a `/clear` moves the id, so an agent
 * looking for its thread's earlier output finds what this generation wrote and
 * not what the one before it did.
 *
 * Takes the account and the Depot rather than a Reach: what it needs is the
 * identity and the folder, and a type standing between it and the string was the
 * `ReachProof` shape written twice (ADR-0020 §4).
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
