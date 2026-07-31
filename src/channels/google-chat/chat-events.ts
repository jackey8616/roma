import type { IngressMessage, PendingEnclosure } from '../../channel-adapter.js'
import type { OperatorLog } from '../../operator-log.js'

/** Fetch the bytes of one thing Chat holds, by the resource name Chat gave it. */
export type DownloadAttachment = (resourceName: string) => Promise<Uint8Array>

/** What reading an event can tell an operator that a Conversation cannot. */
export type ChatEventLogRecord = {
  /**
   * An event carried something attachment-shaped and roma read no Enclosure
   * out of it.
   *
   * The one line standing between "roma cannot read this payload" and the bug
   * it was built to fix. Everything in this file was written from Google's
   * documentation rather than from a capture, and the envelope depends on how
   * an event was delivered — roma is on Pub/Sub, not an HTTP webhook — so the
   * shape below is a guess until a real message proves it. A wrong guess
   * produces `null` and falls through: no throw, no reply, roma silently
   * ignoring images, which is indistinguishable from the fault this whole area
   * exists to remove. This is what makes it distinguishable.
   *
   * `keys` rather than the payload, because an attachment's metadata is
   * somebody's filename and roma writes an Operator Log it does not otherwise
   * put user content in. The keys are enough to say which shape arrived.
   */
  readonly event: 'attachment-unread'
  readonly keys: readonly string[]
}

/**
 * One event as Google Chat delivers it.
 *
 * Left open for the reason `ClaudeEvent` is: the shape is not ours. Chat adds
 * fields, and the envelope an event arrives in depends on how it was delivered —
 * which is the ingress subscriber's business (#13), not this file's. Everything
 * roma reads out of one is read below, so a change in Chat's shape breaks in one
 * place rather than everywhere.
 */
export type ChatEvent = Readonly<Record<string, unknown>>

/**
 * The two ways an event says "this is a 1:1 conversation".
 *
 * The distinction the Conversation Key turns on, and it is asked of the space
 * rather than of the message. `spaceType` is the current field and `type` is its
 * deprecated predecessor; both are read because which one an event carries
 * depends on how it was delivered, and neither is worth being wrong about — a
 * DM read as a space would make every message its own Conversation, and a space
 * read as a DM would merge everybody in it into one.
 *
 * **Not** `spaceThreadingState`, which is the obvious-looking field and the
 * wrong one twice over: it is documented output-only on the Space resource, so
 * an event payload need not carry it at all, and `GROUPED_MESSAGES` spaces have
 * threads as surely as `THREADED_MESSAGES` ones do. Keying on it would have sent
 * every space message down the DM path.
 * https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces
 */
const DIRECT_MESSAGE = 'DIRECT_MESSAGE'
const DM = 'DM'

/**
 * Read one Chat event as a message for the Core, or null if roma should not
 * answer it.
 *
 * This is where a Channel stops existing: a thread, a space, a sender and an
 * @-mention go in, and what comes out is a key, a Caller and some text.
 *
 * Null covers everything roma is delivered and does not answer: the app being
 * added to or removed from a space, a card click, and — the one that matters —
 * anything an app said. Chat marks app messages `type: "BOT"`, and answering
 * them is how two bots in one space talk to each other until somebody notices.
 */
export function readIngressMessage(
  event: ChatEvent,
  { download, log }: ReadOptions = {},
): IngressMessage | null {
  if (asString(event['type']) !== 'MESSAGE') return null

  const message = asRecord(event['message'])
  if (message === null) return null
  const sender = asRecord(message['sender'])
  const caller = asString(sender?.['name'])
  if (caller === null || asString(sender?.['type']) === 'BOT') return null
  // The readable half of the same person, and null where Chat did not send one.
  // It is not on every delivery, and Chat's own User resource has `isAnonymous`
  // for somebody who has no name to give — so this is read the way every other
  // field here is read, and roma answers the message either way.
  const callerName = asString(sender?.['displayName'])

  // The event carries the space, and so does the message inside it. Either will
  // do and neither is always present, so both are tried before giving up.
  const space = asRecord(event['space']) ?? asRecord(message['space'])
  const spaceName = asString(space?.['name'])
  if (spaceName === null) return null

  // A DM has no threads to speak of — Chat still puts one on each message, and
  // reading it here would make every message in the DM its own Conversation,
  // which is the opposite of the one long-lived Session per person ADR-0004
  // wants.
  const direct =
    asString(space?.['spaceType']) === DIRECT_MESSAGE || asString(space?.['type']) === DM
  const thread = asString(asRecord(message['thread'])?.['name'])
  // A message in a space with no thread on it should not happen. If it ever
  // does, falling back to the space would put one Conversation's context into
  // every other Conversation in that space — everybody's work in everybody
  // else's replies — so it is left unanswered instead, which is at least
  // visible.
  if (!direct && thread === null) return null

  // `argumentText` is the message with roma's @-mention removed, which is what
  // Claude Code should see: the mention is how Chat addresses roma, not part of
  // what was asked.
  const text = (asString(message['argumentText']) ?? asString(message['text']) ?? '').trim()
  const enclosures = readEnclosures(message, download, log)
  // A message with *nothing* in it is not a request — a bare @-mention with
  // nothing after it, say, where answering would spend a Turn asking Claude Code
  // what to make of an empty message.
  //
  // Nothing in it, rather than no text in it. That distinction did not exist
  // when this rule was written, because text was all a message could carry; a
  // pasted screenshot with no words is the most ordinary thing there is to do in
  // a chat window and carries more than most one-line messages (ADR-0011).
  if (text === '' && enclosures.length === 0) return null

  // The Conversation Key doubles as the address a reply goes to, which is what
  // lets this Adapter store nothing: `spaces/{space}/threads/{thread}` is a
  // thread, `spaces/{space}` on its own is a DM, and `GoogleChatAdapter` reads
  // the difference back out of the key months later.
  return {
    conversationKey: direct || thread === null ? spaceName : thread,
    caller,
    callerName,
    text,
    enclosures,
  }
}

/** What reading an event needs beyond the event. */
export interface ReadOptions {
  /**
   * How to fetch an attachment's bytes, or absent where roma cannot.
   *
   * Optional so that reading an event stays a pure function in the tests that
   * only care about keys and text. A read with no downloader produces no
   * Enclosures, which is what a deployment with no Chat credentials should do.
   */
  readonly download?: DownloadAttachment
  readonly log?: OperatorLog<ChatEventLogRecord>
}

/**
 * Chat's two ways of attaching something, and roma's reach into each.
 *
 * `attachmentDataRef` is Chat's own storage and is fetched with the app's
 * credentials. `driveDataRef` names a file in the **sender's** Drive, which roma
 * has no scope for and no consent to read — so an Enclosure is still made for
 * one, and it fails when redeemed. Made rather than dropped deliberately: the
 * Task then ends with a reason the person can read, where dropping it silently
 * would put roma back to ignoring what somebody sent.
 *
 * Both are read, and neither is assumed, for the reason every other pair in this
 * file is read that way — `spaceType`/`type`, `event.space`/`message.space`,
 * `common.parameters`/`action.parameters`. The envelope depends on how the event
 * was delivered, and nothing here has ever seen a real one.
 */
function readEnclosures(
  message: Readonly<Record<string, unknown>>,
  download: DownloadAttachment | undefined,
  log: OperatorLog<ChatEventLogRecord> | undefined,
): readonly PendingEnclosure[] {
  const attachments = message['attachment'] ?? message['attachments']
  if (!Array.isArray(attachments) || attachments.length === 0) return []

  const enclosures: PendingEnclosure[] = []
  for (const entry of attachments) {
    const attachment = asRecord(entry)
    if (attachment === null) continue
    // Chat's own name for the file, which roma prints and never makes into a
    // path — see `PendingEnclosure`. `contentName` is the documented field;
    // falling back to the resource name keeps an Enclosure readable rather than
    // nameless where it is missing.
    const name = asString(attachment['contentName']) ?? asString(attachment['name']) ?? 'attachment'

    const resourceName = asString(asRecord(attachment['attachmentDataRef'])?.['resourceName'])
    if (resourceName !== null && download !== undefined) {
      enclosures.push({ name, redeem: () => download(resourceName) })
      continue
    }

    const driveFileId = asString(asRecord(attachment['driveDataRef'])?.['driveFileId'])
    if (driveFileId !== null) {
      enclosures.push({
        name,
        redeem: () =>
          Promise.reject(
            new Error(
              `${name} is a Google Drive file, and roma can only read files uploaded to the conversation`,
            ),
          ),
      })
    }
  }

  // Nothing understood out of something that was plainly there. See
  // `ChatEventLogRecord`: this is the difference between a payload roma cannot
  // read and a roma that ignores images, and without it they look the same.
  if (enclosures.length === 0) {
    log?.({
      event: 'attachment-unread',
      keys: [...new Set(attachments.flatMap((entry) => Object.keys(asRecord(entry) ?? {})))],
    })
  }

  return enclosures
}

/**
 * Chat's own name for a button press, and roma's name for the one it has.
 *
 * The action name travels out on the button and comes back on the click, so
 * these two constants are the whole of the round trip.
 */
const CARD_CLICKED = 'CARD_CLICKED'
export const TAKE_OVERFLOW = 'takeOverflow'
export const TASK_ID_PARAMETER = 'taskId'

/**
 * Read a click on the Overflow button as the Task it was about, or null.
 *
 * Written from Google's documented shape rather than from a capture — like every
 * Chat event in this repo, and for the same reason: nothing here can produce a
 * real one. Both parameter shapes are read because Chat has two. `common.parameters`
 * is an object on the current interaction event; `action.parameters` is a list of
 * `{key, value}` pairs on the older one, and which arrives depends on how the
 * event was delivered. Reading one and not the other would make the button do
 * nothing at all, silently, for whichever half of the deliveries carries the
 * other — and a button that does nothing is worse than no button, because
 * somebody waiting on a blocked Task presses it and then keeps waiting.
 * https://developers.google.com/workspace/chat/read-form-data
 */
export function readOverflowTaken(event: ChatEvent): string | null {
  if (asString(event['type']) !== CARD_CLICKED) return null

  const common = asRecord(event['common'])
  if (asString(common?.['invokedFunction']) === TAKE_OVERFLOW) {
    const taskId = asString(asRecord(common?.['parameters'])?.[TASK_ID_PARAMETER])
    if (taskId !== null) return taskId
  }

  const action = asRecord(event['action'])
  if (asString(action?.['actionMethodName']) !== TAKE_OVERFLOW) return null
  const parameters = action?.['parameters']
  if (!Array.isArray(parameters)) return null
  for (const entry of parameters) {
    const pair = asRecord(entry)
    if (asString(pair?.['key']) === TASK_ID_PARAMETER) return asString(pair?.['value'])
  }
  return null
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
