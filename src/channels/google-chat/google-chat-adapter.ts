import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { ChatAction, ChatApi, ChatMessage } from './chat-api.js'
import {
  CHOOSE,
  CHOOSES_PARAMETER,
  OPTION_PARAMETER,
  readChosenOption,
  readIngressMessage,
  readOverflowTaken,
  TASK_ID_PARAMETER,
  TAKE_OVERFLOW,
  type ChatEvent,
  type ChatEventLogRecord,
} from './chat-events.js'
import type { OperatorLog } from '../../operator-log.js'
import { OVERFLOW_BUTTON, outcomeMessages, progressText } from './render.js'

const REPLY_OR_START_THREAD = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'

/**
 * The instructions after which a Task has no acknowledgement left to keep.
 *
 * Named as a set rather than asked as "not progress", because that is no longer
 * the same question: a blocked Task has been told something and is still
 * running, and its acknowledgement is still the message it will keep editing.
 */
const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome', 'choice'])

function named(segment: string | undefined): segment is string {
  return segment !== undefined && segment !== ''
}

export interface GoogleChatAdapterOptions {
  readonly api: ChatApi
  /**
   * Where to say that an event carried something attachment-shaped roma could
   * not read. Without it, that failure is silent.
   */
  readonly log?: OperatorLog<ChatEventLogRecord>
}

/**
 * Google Chat's Channel Adapter. It keeps no record of who is talking to whom:
 * a reply is addressed by parsing the Conversation Key the Core hands back, so a
 * restart mid-Conversation changes nothing. The one thing it keeps is which
 * message carries each running Task's acknowledgement, which a restart loses
 * along with the Task.
 */
export class GoogleChatAdapter implements ChannelAdapter<ChatEvent> {
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: ChatApi
  /** Enforced by `fence:gchat-acknowledgement-held-from-the-post`. */
  readonly #acknowledgements = new Map<string, Promise<string>>()

  readonly #log: OperatorLog<ChatEventLogRecord> | undefined

  constructor({ api, log }: GoogleChatAdapterOptions) {
    this.#api = api
    this.#log = log
  }

  /**
   * One Chat event as a message for the Core, or null if roma should not answer
   * it. Which events those are is `readIngressMessage`'s business.
   */
  toIngress(event: ChatEvent): IngressMessage | null {
    return (
      readIngressMessage(event, {
        download: (resourceName) => this.#api.download(resourceName),
        ...(this.#log === undefined ? {} : { log: this.#log }),
      }) ?? readChosenOption(event)
    )
  }

  /**
   * A click on the Overflow button, as the Task it was about. The Task id makes
   * the round trip as a parameter on the button, so nothing is remembered
   * between the offer and its being taken.
   */
  toOverflowTaken(event: ChatEvent): string | null {
    return readOverflowTaken(event)
  }

  /**
   * Carry out one instruction, as one or more Chat messages. Progress edits the
   * acknowledgement in place; everything else is a new message.
   *
   * Rejecting means the Conversation was not told.
   * Enforced by `fence:gchat-deliver-rejects-what-chat-refused`.
   */
  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey } = instruction

    if (instruction.kind === 'progress') {
      // Mentioned on the acknowledgement as well as on the result, because a
      // thread can have two of these mutating side by side — one running, one
      // queued behind it — and the person waiting is who most needs to know
      // which is theirs. Chat notifies on the post and not on the edits, so this
      // is one notification per Task rather than one per update.
      const text = progressText(instruction.caller, instruction.progress)
      await this.#acknowledge(taskId, conversationKey, text)
      return
    }

    // Only where the Task is actually over. `blocked`, `overflow-refused` and
    // `context-full` are messages about a Task that is still going: forgetting its
    // acknowledgement there would strand the one the person is watching on
    // "Working…" for as long as the window takes, and post a second one when the
    // Task started again. Dropped before the messages are posted rather than
    // after, so that a post that throws still leaves nothing behind.
    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)

    // Two messages can carry buttons and they are never the same message: the
    // block that offers Overflow (ADR-0002 puts the valve at the moment of
    // blocking rather than in a setting), and the Menu somebody may choose from
    // (ADR-0023).
    const actions =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? [this.#offer(taskId)]
        : instruction.kind === 'choice'
          ? this.#choices(instruction.chooses, instruction.options)
          : undefined

    // Enforced by `fence:gchat-buttons-under-the-last-piece`.
    const messages = outcomeMessages(instruction)
    for (const [at, text] of messages.entries()) {
      const last = at === messages.length - 1
      await this.#api.post({
        ...this.#addressed(conversationKey, text),
        ...(actions === undefined || !last ? {} : { actions }),
      })
    }
  }

  /** Enforced by `fence:gchat-overflow-names-the-task`. */
  #offer(taskId: string): ChatAction {
    return {
      label: OVERFLOW_BUTTON,
      action: TAKE_OVERFLOW,
      parameters: { [TASK_ID_PARAMETER]: taskId },
    }
  }

  /**
   * One button per name on a Menu.
   *
   * Labelled with the name itself and nothing around it, unlike the Overflow
   * button, whose label had to carry what pressing it costs. These cost nothing,
   * and the bare name is also the string a Caller would type — so the card
   * teaches the typed form rather than replacing it.
   *
   * Named by the Command and the name rather than by the Conversation: the press
   * comes back as `/model opus`, which means what it means wherever and whenever
   * it is pressed, so nothing here has to be scoped or expired (ADR-0023).
   */
  #choices(chooses: string, options: readonly string[]): readonly ChatAction[] {
    return options.map((option) => ({
      label: option,
      action: CHOOSE,
      parameters: { [CHOOSES_PARAMETER]: chooses, [OPTION_PARAMETER]: option },
    }))
  }

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
      // Enforced by `fence:gchat-acknowledgement-forgets-a-failed-post`.
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

  /**
   * Where a message goes, read out of the Conversation Key.
   *
   * `spaces/{space}/threads/{thread}` is a thread, replied into with the option
   * that establishes it if it does not exist — an app cannot create one any
   * other way. `spaces/{space}` alone is a DM and is posted plainly.
   *
   * The segment is `threads/`, verified against the API reference and **not**
   * ADR-0004's `messages/`, which is a *message's* resource name. A key in the
   * wrong shape is refused here rather than posted somewhere unintended.
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
