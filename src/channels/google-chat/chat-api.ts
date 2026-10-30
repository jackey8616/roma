/**
 * Something a person can do to a message roma posted, as a button on it: take
 * Overflow on a blocked Task, or pick a name off a Menu. In roma's terms;
 * whatever speaks HTTP turns it into Chat's `cardsV2`.
 */
export interface ChatAction {
  readonly label: string
  /** Chat's `action.function` — the name a click comes back carrying. */
  readonly action: string
  /** Chat's `action.parameters`, which is how a click says what it is about. */
  readonly parameters: Readonly<Record<string, string>>
}

/** One message to post into a Chat space, with everything the Adapter decides already settled. */
export interface ChatMessage {
  /** `spaces/{space}`, taken from the event that started the Conversation. */
  readonly space: string
  /**
   * The thread to speak into, or null in a DM, which has none. Named
   * `spaces/{space}/messages/{message}`, after the message that opened it.
   */
  readonly thread: string | null
  readonly text: string
  /** Chat's `messageReplyOption`, set exactly when this message is going into a thread. */
  readonly replyOption?: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
  /** The buttons on this message: absent where there is nothing to press, never empty. */
  readonly actions?: readonly ChatAction[]
}

/**
 * The Chat API as roma uses it: post a message, edit one, and fetch an
 * Enclosure's bytes. Narrow, so a test double need not be most of a Chat server.
 */
export interface ChatApi {
  /**
   * Post a message and hand back its resource name,
   * `spaces/{space}/messages/{message}`: the only way to edit it afterwards.
   */
  post(message: ChatMessage): Promise<string>

  /** Replace the text of a message roma posted, named as `post` returned it. */
  edit(name: string, text: string): Promise<void>

  /**
   * Fetch the bytes of something attached to a message, by Chat's resource name
   * for it. Only ever called for an `attachmentDataRef`, never a `driveDataRef`.
   */
  download(resourceName: string): Promise<Uint8Array>
}
