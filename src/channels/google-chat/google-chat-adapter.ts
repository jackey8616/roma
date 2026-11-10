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

const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome', 'choice'])

function named(segment: string | undefined): segment is string {
  return segment !== undefined && segment !== ''
}

export interface GoogleChatAdapterOptions {
  readonly api: ChatApi
  readonly log?: OperatorLog<ChatEventLogRecord>
}

export class GoogleChatAdapter implements ChannelAdapter<ChatEvent> {
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: ChatApi
  readonly #acknowledgements = new Map<string, Promise<string>>()

  readonly #log: OperatorLog<ChatEventLogRecord> | undefined

  constructor({ api, log }: GoogleChatAdapterOptions) {
    this.#api = api
    this.#log = log
  }

  toIngress(event: ChatEvent): IngressMessage | null {
    return (
      readIngressMessage(event, {
        download: (resourceName) => this.#api.download(resourceName),
        ...(this.#log === undefined ? {} : { log: this.#log }),
      }) ?? readChosenOption(event)
    )
  }

  toOverflowTaken(event: ChatEvent): string | null {
    return readOverflowTaken(event)
  }

  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey } = instruction

    if (instruction.kind === 'progress') {
      const text = progressText(instruction.caller, instruction.progress)
      await this.#acknowledge(taskId, conversationKey, text)
      return
    }

    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)

    const actions =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? [this.#offer(taskId)]
        : instruction.kind === 'choice'
          ? this.#choices(instruction.chooses, instruction.options)
          : undefined

    const messages = outcomeMessages(instruction)
    for (const [at, text] of messages.entries()) {
      const last = at === messages.length - 1
      await this.#api.post({
        ...this.#addressed(conversationKey, text),
        ...(actions === undefined || !last ? {} : { actions }),
      })
    }
  }

  #offer(taskId: string): ChatAction {
    return {
      label: OVERFLOW_BUTTON,
      action: TAKE_OVERFLOW,
      parameters: { [TASK_ID_PARAMETER]: taskId },
    }
  }

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
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

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
