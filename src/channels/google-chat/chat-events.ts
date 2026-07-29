import type { IngressMessage } from '../../channel-adapter.js'

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
 * @-mention go in, and what comes out is a key, an identity and some text.
 *
 * Null covers everything roma is delivered and does not answer: the app being
 * added to or removed from a space, a card click, and — the one that matters —
 * anything an app said. Chat marks app messages `type: "BOT"`, and answering
 * them is how two bots in one space talk to each other until somebody notices.
 */
export function readIngressMessage(event: ChatEvent): IngressMessage | null {
  if (asString(event['type']) !== 'MESSAGE') return null

  const message = asRecord(event['message'])
  if (message === null) return null
  const sender = asRecord(message['sender'])
  const caller = asString(sender?.['name'])
  if (caller === null || asString(sender?.['type']) === 'BOT') return null

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
  // A bare @-mention with nothing after it is not a request. Answering it would
  // spend a Turn asking Claude Code what to make of an empty message.
  if (text === '') return null

  // The Conversation Key doubles as the address a reply goes to, which is what
  // lets this Adapter store nothing: `spaces/{space}/threads/{thread}` is a
  // thread, `spaces/{space}` on its own is a DM, and `GoogleChatAdapter` reads
  // the difference back out of the key months later.
  return { conversationKey: direct || thread === null ? spaceName : thread, caller, text }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
