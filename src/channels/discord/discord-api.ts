import type { DiscordMessage } from './discord-events.js'

/**
 * Something a person can do to a message roma posted, as a button on it.
 *
 * Shaped like roma's use of Discord rather than like Discord — the same
 * judgement `DiscordApi` below is built on. Whatever speaks HTTP turns this into
 * the `components` payload Discord wants; what matters at this boundary is what
 * the button says and what comes back when it is pressed, because those are the
 * two halves of the round trip.
 *
 * There are two kinds and they are the two things anybody can press: taking
 * Overflow on a blocked Task (ADR-0002), and picking a name off a Menu
 * (ADR-0023). A Menu is several at once, so a message carries a list.
 */
export interface DiscordButton {
  /** What the button says. */
  readonly label: string
  /**
   * Discord's `custom_id` — the whole of what a press carries back.
   *
   * *"1-100 characters"*, and roma spends about forty of them. What goes in one
   * and why it holds the Conversation Key as well as the Command is
   * `discord-events.ts`'s `chooseId`.
   */
  readonly customId: string
}

/**
 * One message roma is about to say, in roma's terms rather than Discord's.
 *
 * Everything the Adapter decided — which channel, what the words are, whether
 * this piece is the one that answers somebody — is settled by the time one of
 * these exists. What turns it into a Discord payload is `HttpDiscordApi`.
 */
export interface DiscordPost {
  /**
   * Where it goes: a thread, one of the guild's own channels, or a direct
   * message.
   *
   * Usually the Conversation Key itself, since a Conversation is a channel here
   * — and deliberately not always, because a thread roma was refused leaves the
   * key naming a place that does not exist (ADR-0029).
   */
  readonly channel: string
  readonly text: string
  /**
   * The message this one answers, or null where it answers none.
   *
   * How a Caller is addressed on this Channel. Chat prefixes every piece of an
   * answer with an @-mention because a mention is what Chat has; Discord's reply
   * is the idiomatic form, costs nothing out of the 2000 characters, and is on
   * the **first** message only — nine replies to one question are nine
   * notifications of it (ADR-0029).
   */
  readonly replyTo: string | null
  /**
   * The buttons on this message, and empty where there is nothing to press.
   *
   * Required and empty rather than optional, for `IngressMessage.enclosures`'
   * reason: a caller with something to draw that forgets to hand it over is
   * indistinguishable from one that had nothing, and the failure is a Menu
   * nobody can press with no error anywhere.
   *
   * Two messages ever carry any — the one saying the Shared Window is spent when
   * Overflow is on offer, and the one offering a Menu — and they are never the
   * same message.
   */
  readonly buttons: readonly DiscordButton[]
}

/**
 * What Discord said no with, in the only terms a retry can act on.
 *
 * Two facts and no interpretation. `status` is what says whether trying again
 * could possibly work — a 403 will be a 403 next time, and every one of those
 * spends roma's way toward the ban below — and `retryAfterMs` is how long
 * Discord asked roma to wait.
 *
 * **`retryAfterMs` is read off the response and never inferred.** Discord's
 * per-route limits are dynamic and its reference says so in as many words:
 * *"rate limits should not be hard coded into your app"*. A retry that ignores
 * a 429 is worse than a slow one, because 429s count toward the *"10,000 per 10
 * minutes"* invalid-request limit whose penalty is a temporary block on the
 * whole API rather than on the channel that earned it — so a naive loop in one
 * Conversation is an outage of every Conversation (ADR-0029).
 *
 * A class rather than a shaped message, because the one caller that acts on this
 * has to tell it from a socket that never answered at all, and a network fault
 * carries no status.
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
 * As much of Discord's REST API as roma calls.
 *
 * Six calls: two that read, for the words behind a Quotation and the bytes
 * behind an Enclosure, three that write, which are the whole of how roma answers
 * anybody here, and one that answers a press inside three seconds.
 *
 * A port rather than a client, for `ChatApi`'s reason: what a test needs on the
 * far side of seam 3 is a recording of what roma asked for, and a port shaped
 * like a library would make that double most of the library. Shaped like roma's
 * use of Discord rather than like Discord — which is why nothing in it names a
 * payload field, and why the one Discord fact that cannot be expressed in roma's
 * terms, `startThread`'s idempotence, is written into that method's promise
 * rather than left for a caller to read out of an error code.
 */
export interface DiscordApi {
  /**
   * One message, by where it lives.
   *
   * Rejects where Discord refuses or does not answer, which the one caller turns
   * into no Quotation at all — the fallback and the unsupported case are one
   * code path on purpose (ADR-0029).
   */
  message(channelId: string, messageId: string): Promise<DiscordMessage>
  /**
   * The bytes behind an attachment.
   *
   * Rejects for the ordinary reason as well as the exceptional one: Discord's
   * attachment URLs expire, and a Task parked for the Shared Window can wait
   * hours (#173).
   */
  download(url: string): Promise<Uint8Array>
  /**
   * Say one thing in one channel, and hand back the id of the message it became.
   *
   * The id is the only way to edit it afterwards, which is what an
   * acknowledgement is for.
   */
  post(message: DiscordPost): Promise<string>
  /** Replace the text of a message roma posted, named as `post` returned it. */
  edit(channelId: string, messageId: string, text: string): Promise<void>
  /**
   * Open a thread from one message, and hand back its id — which is the
   * message's own.
   *
   * *"The created thread and the message it was started from will share the same
   * id"*, which is the fact the whole Conversation Key table rests on: the key
   * minted before the thread exists is the id the thread will have.
   *
   * **A message that already has a thread is a success, not a failure.** *"A
   * message can only have a single thread created from it"* — so an
   * implementation that reported the second attempt as an error would make every
   * retry permanent, and roma would answer in a channel it had already opened a
   * thread in. Resolving means the thread exists; how it came to is nobody's
   * business up here.
   *
   * Rejects where Discord refuses for any other reason — no permission, or a
   * forum or media channel, where the route *"does not work"* at all. The one
   * caller reads that as the signal ADR-0029 says it is, and posts in the
   * channel the message arrived in instead.
   */
  startThread(channelId: string, messageId: string, name: string): Promise<string>
  /**
   * Say that a press arrived, inside the three seconds it is good for, and leave
   * the card exactly as it was.
   *
   * **The deadline is the whole reason this exists.** *"You must send an initial
   * response within 3 seconds of receiving the event. If the 3 second deadline
   * is exceeded, the token will be invalidated"* — and roma's Core takes
   * minutes. So this goes out before the press reaches anything that could
   * answer it, which is why it is the Transport's rather than the Adapter's
   * (ADR-0029).
   *
   * **The card must not change.** Pressing is typing, and typing does not
   * rewrite the message you typed into — so what is sent is
   * `DEFERRED_UPDATE_MESSAGE`, which is *"ACK an interaction and edit the
   * original message later; the user does not see a loading state"*. roma never
   * takes the second half of that offer.
   *
   * Rejects like any other call. The one caller writes it down and hands the
   * press on anyway: a press roma failed to acknowledge is one Discord will mark
   * as failed, and answering it late is better than a Task that stays blocked
   * because nobody could take the offer.
   */
  acknowledgePress(interactionId: string, token: string): Promise<void>
}
