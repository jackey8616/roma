import type { DiscordMessage } from './discord-events.js'

/**
 * Something a person can do to a message roma posted, as a button on it: take
 * Overflow on a blocked Task, or pick a name off a Menu. In roma's terms;
 * whatever speaks HTTP turns it into Discord's `components`.
 */
export interface DiscordButton {
  readonly label: string
  /**
   * Discord's `custom_id`, the whole of what a press carries back: *"1-100
   * characters"*. What goes in one is `discord-events.ts`'s `chooseId`.
   */
  readonly customId: string
}

/**
 * One message roma is about to say, in roma's terms, with everything the Adapter
 * decides already settled. `HttpDiscordApi` turns it into a Discord payload.
 */
export interface DiscordPost {
  /**
   * A thread, one of the guild's own channels, or a direct message. Usually the
   * Conversation Key, but not where a thread roma was refused left the key naming
   * a place that does not exist.
   */
  readonly channel: string
  readonly text: string
  /**
   * The message this one answers, or null where it answers none. Set on the
   * first piece of an answer only. Enforced by `fence:discord-reply-on-first-piece-only`.
   */
  readonly replyTo: string | null
  /**
   * The buttons on this message, and empty where there is nothing to press.
   *
   * **At most `MAX_BUTTONS`, and whoever fills this decides what a wider Menu
   * does.** Nothing below here trims the list.
   * Enforced by `fence:discord-menu-whole-or-not-at-all`.
   * Enforced by `fence:discord-http-trims-no-menu`.
   */
  readonly buttons: readonly DiscordButton[]
}

/**
 * How many buttons one message may carry: five rows of five.
 * Enforced by `fence:discord-buttons-fit-one-message`.
 */
export const MAX_BUTTONS = 25

/**
 * What Discord said no with: `status`, which says whether trying again could
 * work, and `retryAfterMs`, how long Discord asked roma to wait. A network fault
 * is never one of these, since it carries no status.
 * Enforced by `fence:discord-retry-after-is-read`.
 */
export class DiscordRefusal extends Error {
  readonly status: number
  readonly retryAfterMs: number | null

  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'DiscordRefusal'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * As much of Discord's REST API as roma calls, as a port in roma's terms: nothing
 * in it names a payload field.
 */
export interface DiscordApi {
  /**
   * One message, by where it lives. Rejects where Discord refuses or does not
   * answer, which the caller treats as no Quotation at all.
   */
  message(channelId: string, messageId: string): Promise<DiscordMessage>
  /**
   * The bytes behind an attachment. Rejects where Discord refuses, and where the
   * URL has expired, which a Task parked for the Shared Window can meet.
   */
  download(url: string): Promise<Uint8Array>
  /**
   * Say one thing in one channel, and hand back the id of the message it became:
   * the only way to edit it afterwards.
   */
  post(message: DiscordPost): Promise<string>
  /** Replace the text of a message roma posted, named as `post` returned it. */
  edit(channelId: string, messageId: string, text: string): Promise<void>
  /**
   * Open a thread from one message, and hand back its id, which is the message's
   * own.
   *
   * **A message that already has a thread is a success, not a failure.**
   * Enforced by `fence:discord-thread-already-created-is-success`.
   *
   * Rejects where Discord refuses for any other reason, such as no permission or
   * a forum or media channel; the caller then posts in the channel the message
   * arrived in.
   */
  startThread(channelId: string, messageId: string, name: string): Promise<string>
  /**
   * Say that a press arrived, leaving the card exactly as it was
   * (`DEFERRED_UPDATE_MESSAGE`). Enforced by `fence:discord-press-ack-leaves-card`.
   *
   * Good for three seconds from the press only, so it must go out before the
   * press reaches anything that could answer it. Rejects like any other call.
   */
  acknowledgePress(interactionId: string, token: string): Promise<void>
}
