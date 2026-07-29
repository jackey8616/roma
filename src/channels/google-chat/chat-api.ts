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
 * click means and which Task it is about, because those are what come back.
 *
 * One action per message, because roma has exactly one thing anybody can press:
 * taking Overflow on a blocked Task. A second would be a reason to revisit this,
 * not a reason to generalise it now.
 */
export interface ChatAction {
  /** What the button says. */
  readonly label: string
  /** Chat's `action.function` — the name a click comes back carrying. */
  readonly action: string
  /** Chat's `action.parameters`, which is how a click says which Task it is about. */
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
   * A button on this message, where there is something to press.
   *
   * Only on the message that says the Shared Window is spent, and only when
   * Overflow is on offer — ADR-0002 puts the valve at the moment of blocking
   * rather than in a setting, and a button on the message that reports the block
   * is that moment.
   */
  readonly action?: ChatAction
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
}
