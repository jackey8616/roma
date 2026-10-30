import type {
  IngressMessage,
  OutboundInstruction,
  PendingEnclosure,
  Quotation,
} from '../../channel-adapter.js'
import { commandFor } from '../../commands.js'
import type { OperatorLog } from '../../operator-log.js'

/** Fetch the bytes of one thing Chat holds, by the resource name Chat gave it. */
export type DownloadAttachment = (resourceName: string) => Promise<Uint8Array>

/** What reading an event can tell an operator that a Conversation cannot. */
export type ChatEventLogRecord =
  | {
      /**
       * An event carried a quoted message and roma read no Quotation out of it.
       *
       * `attachment-unread`'s argument, and it lands harder here. Chat's
       * `quotedMessageSnapshot` is documented output-only on the *Message
       * resource*, and what an interaction event carries is a separate question
       * this repository cannot answer — so the single reading everything else
       * rests on, that the words arrive in the payload, is the one nobody has
       * seen hold. If it does not, roma answers every quoted message as though
       * the quotation were not there, which is exactly what roma did before this
       * existed. This line is the difference (ADR-0021).
       *
       * `keys` rather than the payload, for the reason below: a quotation is
       * somebody's words, and the Operator Log is not where roma puts those. The
       * snapshot's own keys are carried under their path, because "the snapshot
       * is missing" and "the snapshot is there and empty" are different faults
       * with different repairs.
       */
      readonly event: 'quote-unread'
      readonly keys: readonly string[]
    }
  | {
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

/** Enforced by `fence:gchat-conversation-key-from-the-space`. */
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
 * added to or removed from a space, a card click, and anything an app said.
 * Enforced by `fence:gchat-never-answers-an-app`.
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

  const conversationKey = conversationKeyOf(event, message)
  if (conversationKey === null) return null

  // `argumentText` is the message with roma's @-mention removed, which is what
  // Claude Code should see: the mention is how Chat addresses roma, not part of
  // what was asked.
  const text = (asString(message['argumentText']) ?? asString(message['text']) ?? '').trim()
  const quoted = readQuotation(message, download, log)
  // The Caller's own first and the quotation's behind them, which is the order
  // they are named to the agent in. Nothing distinguishes them here beyond the
  // `from` each carries — an Enclosure is an Enclosure, whoever sent it, and the
  // Core writes them all into one Working Directory in one pass.
  const enclosures = [...readEnclosures(message, null, download, log), ...quoted.enclosures]
  // Enforced by `fence:gchat-answers-anything-with-content`.
  if (text === '' && enclosures.length === 0 && quoted.quotation === null) return null

  return {
    conversationKey,
    caller,
    callerName,
    text,
    enclosures,
    quotation: quoted.quotation,
  }
}

/** Enforced by `fence:gchat-conversation-key-from-the-space`. */
function conversationKeyOf(
  event: ChatEvent,
  message: Readonly<Record<string, unknown>>,
): string | null {
  // The event carries the space, and so does the message inside it. Either will
  // do and neither is always present, so both are tried before giving up.
  const space = asRecord(event['space']) ?? asRecord(message['space'])
  const spaceName = asString(space?.['name'])
  if (spaceName === null) return null

  const direct =
    asString(space?.['spaceType']) === DIRECT_MESSAGE || asString(space?.['type']) === DM
  const thread = asString(asRecord(message['thread'])?.['name'])
  if (!direct && thread === null) return null

  return direct || thread === null ? spaceName : thread
}

interface QuotedMessage {
  readonly quotation: Quotation | null
  readonly enclosures: readonly PendingEnclosure[]
}

const NOTHING_QUOTED: QuotedMessage = { quotation: null, enclosures: [] }

function readQuotation(
  message: Readonly<Record<string, unknown>>,
  download: DownloadAttachment | undefined,
  log: OperatorLog<ChatEventLogRecord> | undefined,
): QuotedMessage {
  const metadata = asRecord(message['quotedMessageMetadata'])
  if (metadata === null) return NOTHING_QUOTED

  const snapshot = asRecord(metadata['quotedMessageSnapshot'])
  // Chat's only sender that is a bare string rather than a `User`, and its
  // documented shape is "the quoted message's author name" — which is an id in
  // one reading and a display name in the other. Carried either way and read
  // neither: printing it is all roma ever does with a person's name.
  const author = asString(snapshot?.['sender'])
  const text = (asString(snapshot?.['text']) ?? '').trim()
  const enclosures = snapshot === null ? [] : readEnclosures(snapshot, author, download, log)
  // Only where there are words. A quotation with no text is a tag with nothing
  // in it, and an attachment that came with it stands on its own already.
  const quotation = text === '' ? null : { text, author }

  if (quotation === null && enclosures.length === 0) {
    log?.({
      event: 'quote-unread',
      keys: [
        ...Object.keys(metadata),
        ...(snapshot === null
          ? []
          : Object.keys(snapshot).map((key) => `quotedMessageSnapshot.${key}`)),
      ],
    })
  }

  return { quotation, enclosures }
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
 * `attachmentDataRef` is Chat's own storage. `driveDataRef` names a file in the
 * **sender's** Drive, which roma has no scope for — an Enclosure is still made
 * and fails when redeemed, so the Task ends with a reason the person can read
 * rather than roma silently ignoring what somebody sent.
 *
 * Both read, neither assumed, like every other pair in this file: the envelope
 * depends on how the event was delivered.
 *
 * `from` is null for the Caller's own — a quoted message's snapshot comes
 * through here too, and its Enclosures have to say so (ADR-0021).
 */
function readEnclosures(
  message: Readonly<Record<string, unknown>>,
  from: string | null,
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
      enclosures.push({ name, from, redeem: () => download(resourceName) })
      continue
    }

    const driveFileId = asString(asRecord(attachment['driveDataRef'])?.['driveFileId'])
    if (driveFileId !== null) {
      enclosures.push({
        name,
        from,
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
 * The other thing anybody can press: one name off a Menu (ADR-0023).
 *
 * Three constants for one round trip, because this button carries two facts
 * where Overflow's carries one — which Command a press means, and which name off
 * its Menu.
 */
export const CHOOSE = 'choose'
export const CHOOSES_PARAMETER = 'chooses'
export const OPTION_PARAMETER = 'option'

/**
 * Read a click on the Overflow button as the Task it was about, or null.
 *
 * The Task id is one roma minted and put on the offer, so this can only ever
 * answer an offer roma actually made.
 *
 * Written from Google's documented shape rather than from a capture, like every
 * Chat event in this repo: nothing here can produce a real one. `pressed` below
 * carries what that costs and how it is paid for.
 */
export function readOverflowTaken(event: ChatEvent): string | null {
  return pressed(event, TAKE_OVERFLOW, TASK_ID_PARAMETER)
}

/**
 * Read a press on a Menu button as the message the Caller would have typed, or
 * null if this event is not one.
 *
 * **Pressing is typing** (ADR-0023). What comes out is an ordinary Ingress
 * Message carrying `/model opus`, so the press goes down the path every typed
 * Command goes down and the Core learns nothing new — which is what makes a card
 * from three weeks ago safe to press, and why nothing has to be remembered
 * between posting one and its being pressed.
 *
 * Whoever pressed is on `event.user`, never on the message's sender.
 * Enforced by `fence:gchat-press-is-read-off-the-presser`.
 *
 * Written from Google's documented shape rather than from a capture, like every
 * other reading in this file, and this one rests on the message travelling with
 * the press — without it there is no thread and so no Conversation Key, and the
 * whole arrangement would need revisiting rather than patching (ADR-0023).
 */
export function readChosenOption(event: ChatEvent): IngressMessage | null {
  const chooses = pressed(event, CHOOSE, CHOOSES_PARAMETER)
  const option = pressed(event, CHOOSE, OPTION_PARAMETER)
  if (chooses === null || option === null) return null
  if (!isMenu(chooses)) return null

  const user = asRecord(event['user'])
  const caller = asString(user?.['name'])
  if (caller === null) return null

  const message = asRecord(event['message'])
  if (message === null) return null
  const conversationKey = conversationKeyOf(event, message)
  if (conversationKey === null) return null

  return {
    conversationKey,
    caller,
    callerName: asString(user?.['displayName']),
    text: commandFor(chooses, option),
    enclosures: [],
    quotation: null,
  }
}

/** Enforced by `fence:gchat-reads-only-the-menus-it-draws`. */
type Menu = Extract<OutboundInstruction, { kind: 'choice' }>['chooses']

/** Enforced by `fence:gchat-reads-only-the-menus-it-draws`. */
const MENUS: Readonly<Record<Menu, true>> = { model: true, effort: true, caveman: true }

function isMenu(name: string): name is Menu {
  return Object.hasOwn(MENUS, name)
}

/** Enforced by `fence:gchat-press-reads-both-shapes`. */
function pressed(event: ChatEvent, action: string, parameter: string): string | null {
  if (asString(event['type']) !== CARD_CLICKED) return null

  const common = asRecord(event['common'])
  if (asString(common?.['invokedFunction']) === action) {
    const value = asString(asRecord(common?.['parameters'])?.[parameter])
    if (value !== null) return value
  }

  const legacy = asRecord(event['action'])
  if (asString(legacy?.['actionMethodName']) !== action) return null
  const parameters = legacy?.['parameters']
  if (!Array.isArray(parameters)) return null
  for (const entry of parameters) {
    const pair = asRecord(entry)
    if (asString(pair?.['key']) === parameter) return asString(pair?.['value'])
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
