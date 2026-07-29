import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { ChatAction, ChatApi, ChatMessage } from './chat-api.js'
import {
  readIngressMessage,
  readOverflowTaken,
  TASK_ID_PARAMETER,
  TAKE_OVERFLOW,
  type ChatEvent,
} from './chat-events.js'
import { OVERFLOW_BUTTON, outcomeMessages, progressText } from './render.js'

/** Chat's own name for the option that makes a reply establish a thread. */
const REPLY_OR_START_THREAD = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'

/**
 * The instructions after which a Task has no acknowledgement left to keep.
 *
 * Named as a set rather than asked as "not progress", because that is no longer
 * the same question: a blocked Task has been told something and is still
 * running, and its acknowledgement is still the message it will keep editing.
 */
const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome'])

/** Whether a path segment names something, rather than being absent or empty. */
function named(segment: string | undefined): segment is string {
  return segment !== undefined && segment !== ''
}

export interface GoogleChatAdapterOptions {
  readonly api: ChatApi
}

/**
 * Google Chat, and the only module in roma that knows Chat exists.
 *
 * A Chat event goes in and an ingress message comes out; an outbound instruction
 * goes in and a Chat API call comes out. Everything Chat-specific is on this side
 * of it — thread names, `messageReplyOption`, the 4096-character limit, the words
 * roma uses — and nothing on the other side has ever heard of any of it.
 *
 * It keeps no record of who is talking to whom, which is ADR-0004's claim that
 * Chat needs no adapter-side identity storage. It can afford that because a
 * Conversation Key *is* a Chat resource name: the space is the first two segments
 * of it, and in a space the key is the thread as well. So a reply months later is
 * addressed by parsing the key the Core handed back, not by remembering anything
 * — and a restart mid-Conversation changes nothing.
 *
 * The one thing it does keep is which message carries each running Task's
 * acknowledgement, and that is nothing to persist: a Task does not survive a
 * restart either.
 */
export class GoogleChatAdapter implements ChannelAdapter<ChatEvent> {
  /**
   * Both true, and both measured against Chat rather than hoped for: Chat can
   * edit a message it has posted, so progress reporting runs in its full form;
   * and a thread name is stable for the life of the thread, so no Conversation
   * Key has to be minted or persisted here.
   */
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: ChatApi
  /**
   * Each Task's acknowledgement, as the promise of the message that carries it.
   *
   * The promise rather than the name, so that the entry exists from the instant
   * the first update is sent rather than from when Chat answers. In between,
   * a second update would otherwise find nothing and post a second
   * acknowledgement — and the Task would have two messages mutating at once.
   *
   * Dropped when the Task ends. A create still in flight then resolves into
   * nothing, which is what should happen: the acknowledgement is finished with.
   */
  readonly #acknowledgements = new Map<string, Promise<string>>()

  constructor({ api }: GoogleChatAdapterOptions) {
    this.#api = api
  }

  /**
   * One Chat event as a message for the Core, or null if roma should not answer
   * it.
   *
   * Which events those are is `readIngressMessage`'s business. What matters here
   * is that the Core never sees an event: by this point a thread, a space, a
   * sender and an @-mention have become a key, an identity and some text.
   */
  toIngress(event: ChatEvent): IngressMessage | null {
    return readIngressMessage(event)
  }

  /**
   * A click on the Overflow button, as the Task it was about.
   *
   * The other half of `#offer` below: what goes out as a parameter on the button
   * comes back as one on the click, so the Task id makes the round trip and roma
   * needs to remember nothing between the offer and its being taken.
   */
  toOverflowTaken(event: ChatEvent): string | null {
    return readOverflowTaken(event)
  }

  /**
   * Carry out one instruction, as one or more Chat messages.
   *
   * Progress edits the acknowledgement in place; everything else is a new
   * message, which is the rule ADR-0003 makes unconditional for a result and
   * this Adapter has no reason to bend for the rest.
   *
   * Rejecting means the Conversation was not told, and the Core treats that as
   * the one failure it cannot absorb — so nothing here swallows an API error.
   */
  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey } = instruction

    if (instruction.kind === 'progress') {
      await this.#acknowledge(taskId, conversationKey, progressText(instruction.progress))
      return
    }

    // Only where the Task is actually over. `blocked` and `overflow-refused`
    // are messages about a Task that is still going: forgetting its
    // acknowledgement there would strand the one the person is watching on
    // "Working…" for as long as the window takes, and post a second one when the
    // Task started again. Dropped before the messages are posted rather than
    // after, so that a post that throws still leaves nothing behind.
    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)
    // Only the message that reports a block can carry one, and only when the
    // valve is on offer — ADR-0002 puts it at the moment of blocking rather than
    // in a setting somebody turns on in advance.
    const offer =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? this.#offer(taskId)
        : undefined
    for (const text of outcomeMessages(instruction)) {
      await this.#api.post({
        ...this.#addressed(conversationKey, text),
        ...(offer === undefined ? {} : { action: offer }),
      })
    }
  }

  /**
   * The button that takes Overflow for one Task.
   *
   * Named by the Task rather than by the Conversation, because that is what the
   * offer is about: a Conversation can have a second Task blocked behind this
   * one, and a button that meant "the blocked Task here" would spend money on
   * whichever of them roma looked at first.
   *
   * Anyone in the Conversation may press it, which is ADR-0002's decision rather
   * than an oversight — restricting it to an admin turns a person into an
   * approval queue and strands urgent work whenever they are offline.
   */
  #offer(taskId: string): ChatAction {
    return {
      label: OVERFLOW_BUTTON,
      action: TAKE_OVERFLOW,
      parameters: { [TASK_ID_PARAMETER]: taskId },
    }
  }

  /** Post the acknowledgement, or edit the one this Task already has. */
  async #acknowledge(taskId: string, conversationKey: string, text: string): Promise<void> {
    const posted = this.#acknowledgements.get(taskId)
    if (posted !== undefined) {
      await this.#api.edit(await posted, text)
      return
    }

    const posting = this.#api.post(this.#addressed(conversationKey, text))
    this.#acknowledgements.set(taskId, posting)
    try {
      await posting
    } catch (error) {
      // A post that failed left no message to edit. Forgetting it is what lets
      // the next update try again — kept, every later update for this Task would
      // edit a name that never existed and fail with an error from minutes ago.
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

  /**
   * Where a message goes, read out of the Conversation Key.
   *
   * `spaces/{space}/threads/{thread}` is a thread, and roma replies into it with
   * the option that makes the reply establish the thread if it does not exist
   * yet — an app cannot create one any other way. `spaces/{space}` on its own is
   * a DM, which has no threads, so the message is posted plainly.
   *
   * The `threads/` segment is Google's, verified against the API reference
   * rather than taken from ADR-0004, which had it as `messages/` — that is a
   * *message's* resource name. A key in the wrong shape is refused here rather
   * than posted somewhere unintended.
   * https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages
   */
  #addressed(conversationKey: string, text: string): ChatMessage {
    const [spaces, space, threads, thread, ...extra] = conversationKey.split('/')
    if (spaces !== 'spaces' || !named(space) || extra.length > 0) {
      throw new Error(`not a Chat Conversation Key: ${conversationKey}`)
    }
    if (threads === undefined) return { space: conversationKey, thread: null, text }
    if (threads !== 'threads' || !named(thread)) {
      throw new Error(`not a Chat Conversation Key: ${conversationKey}`)
    }
    return {
      space: `spaces/${space}`,
      thread: conversationKey,
      text,
      replyOption: REPLY_OR_START_THREAD,
    }
  }
}
