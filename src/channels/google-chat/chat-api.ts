/**
 * One message to post into a Chat space.
 *
 * The fields Chat's `spaces.messages.create` needs and nothing else. Everything
 * the Adapter decided — which thread, what the words are — is already settled by
 * the time one of these exists.
 */
/**
 * Something a person can do to a message roma posted, as a button on it.
 *
 * Shaped like roma's use of Chat rather than like Chat — the same judgement
 * `ChatApi` below is built on. Whatever speaks HTTP turns this into the
 * `cardsV2` payload Chat wants; what matters at this boundary is which action a
 * click means and what it is about, because those are what come back.
 *
 * There were two kinds of these for a while and the second is what ended the
 * one-per-message rule this used to state: taking Overflow on a blocked Task,
 * and picking a name off a Menu (ADR-0023). A Menu is several at once, so a
 * message carries a list.
 */
export interface ChatAction {
  /** What the button says. */
  readonly label: string
  /** Chat's `action.function` — the name a click comes back carrying. */
  readonly action: string
  /** Chat's `action.parameters`, which is how a click says what it is about. */
  readonly parameters: Readonly<Record<string, string>>
}

export interface ChatMessage {
  /** `spaces/{space}`, taken from the event that started the Conversation. */
  readonly space: string
  /**
   * The thread to speak into, or null in a DM, which has none.
   *
   * `spaces/{space}/messages/{message}` — a thread is named after the message
   * that opened it, which is also why it doubles as the Conversation Key.
   */
  readonly thread: string | null
  readonly text: string
  /**
   * Chat's `messageReplyOption`, set exactly when this message is going into a
   * thread.
   *
   * Travels with the message rather than being applied by whatever speaks HTTP,
   * so that the one thing ADR-0004 is emphatic about is visible at the boundary
   * and a test can assert it: an app cannot create a thread of its own in Chat,
   * so replying *into* the thread the caller's message is in is the only way a
   * thread ever comes to exist.
   */
  readonly replyOption?: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
  /**
   * The buttons on this message, where there is something to press.
   *
   * Two messages carry any: the one saying the Shared Window is spent, when
   * Overflow is on offer (ADR-0002 puts the valve at the moment of blocking
   * rather than in a setting), and the one offering a Menu to choose a model or
   * an effort from (ADR-0023). Absent everywhere else, and never empty where
   * present — a card holding no buttons is a card with nothing in it.
   */
  readonly actions?: readonly ChatAction[]
}

/**
 * The Chat API as roma uses it: post a message, edit a message.
 *
 * Two calls, because that is all a Channel Adapter needs to carry out every
 * outbound instruction the Core has. Narrow on purpose — an interface shaped
 * like the Chat API rather than like roma's use of it would be most of a client
 * library, and the double a test needs would be most of a Chat server.
 *
 * Implementations live outside this file. `HttpChatApi` is the one that speaks
 * HTTP, and it arrived with the Pub/Sub ingress because it shares that ticket's
 * credential handling — both are the Chat app authenticating as itself. Seam 3
 * asserts against a recording double on the other side of this boundary, and
 * against the request Google would have received on the other side of
 * `HttpChatApi`'s own.
 */
export interface ChatApi {
  /**
   * Post a message and hand back its resource name.
   *
   * The name — `spaces/{space}/messages/{message}` — is the only way to edit the
   * message afterwards, which is what an acknowledgement is for.
   *
   * Replies always carry `messageReplyOption:
   * REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, which is not a preference: an app
   * cannot create a thread of its own in Chat, so replying *into* the thread the
   * caller's message is in is the only way a thread ever comes to exist
   * (ADR-0004).
   */
  post(message: ChatMessage): Promise<string>

  /** Replace the text of a message roma posted, named as `post` returned it. */
  edit(name: string, text: string): Promise<void>

  /**
   * Fetch the bytes of something attached to a message, by Chat's resource name
   * for it.
   *
   * A third call rather than two, and the first that reads rather than writes.
   * It is here because an Enclosure has to come from somewhere and only the
   * Chat app's own credentials can reach Chat's storage — the same authenticated
   * client `post` and `edit` already use.
   *
   * Only ever called for an `attachmentDataRef`, which is content uploaded into
   * the conversation. A `driveDataRef` names a file in the sender's Drive and
   * never reaches this method: roma has no Drive scope and no consent from that
   * person, so there is nothing for an implementation to try.
   */
  download(resourceName: string): Promise<Uint8Array>
}
