/**
 * One message to post into a Chat space.
 *
 * The fields Chat's `spaces.messages.create` needs and nothing else. Everything
 * the Adapter decided — which thread, what the words are — is already settled by
 * the time one of these exists.
 */
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
}

/**
 * The Chat API as roma uses it: post a message, edit a message.
 *
 * Two calls, because that is all a Channel Adapter needs to carry out every
 * outbound instruction the Core has. Narrow on purpose — an interface shaped
 * like the Chat API rather than like roma's use of it would be most of a client
 * library, and the double a test needs would be most of a Chat server.
 *
 * Implementations live outside this file. The one that speaks HTTP arrives with
 * the Pub/Sub ingress and the credential handling it shares (#13); until then
 * this is the whole of the boundary, and seam 3 asserts against a recording
 * double on the other side of it.
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
