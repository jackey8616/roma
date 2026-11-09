import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
import { writeToStderr, type OperatorLog } from '../../operator-log.js'
import { DiscordRefusal, MAX_BUTTONS, type DiscordApi, type DiscordButton } from './discord-api.js'
import {
  asString,
  chooseId,
  overflowId,
  readChosenOption,
  readIngressMessage,
  readOverflowTaken,
  type DiscordEvent,
} from './discord-events.js'
import { OVERFLOW_BUTTON, outcomeMessages, progressText, threadName } from './render.js'

export const ATTEMPTS = 3

export const RETRY_FLOOR_MS = 500
export const RETRY_CEILING_MS = 30_000

export const REMEMBERED = 1_000

const ENDS_THE_TASK = new Set(['result', 'failure', 'stopped', 'command-outcome', 'choice'])

interface Answering {
  readonly channel: string
  readonly replyTo: string | null
}

interface Answered {
  readonly channel: string
  readonly message: string
  readonly name: string
  place: Promise<string> | null
}

export type DiscordAdapterLogRecord = {
  readonly event: 'thread-unopened'
  readonly channel: string
  readonly status: number
}

export interface DiscordAdapterOptions {
  readonly api: DiscordApi
  readonly log?: OperatorLog<DiscordAdapterLogRecord>
  readonly wait?: (ms: number) => Promise<void>
}

export class DiscordAdapter implements ChannelAdapter<DiscordEvent> {
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: DiscordApi
  readonly #log: OperatorLog<DiscordAdapterLogRecord>
  readonly #wait: (ms: number) => Promise<void>

  readonly #answering = new Map<string, Answered>()

  readonly #acknowledgements = new Map<string, Promise<string>>()

  constructor({ api, log, wait }: DiscordAdapterOptions) {
    this.#api = api
    this.#log = log ?? writeToStderr
    this.#wait = wait ?? sleep
  }

  toIngress(event: DiscordEvent): IngressMessage | null {
    const message =
      readChosenOption(event) ??
      readIngressMessage(event, {
        download: (url) => this.#api.download(url),
      })
    if (message !== null) this.#remember(event, message)
    return message
  }

  toOverflowTaken(event: DiscordEvent): string | null {
    return readOverflowTaken(event)
  }

  async deliver(instruction: OutboundInstruction): Promise<void> {
    const { taskId, conversationKey } = instruction
    const answering = await this.#answeringFor(instruction)

    if (instruction.kind === 'progress') {
      await this.#acknowledge(taskId, answering, progressText(instruction.progress))
      return
    }

    if (ENDS_THE_TASK.has(instruction.kind)) this.#acknowledgements.delete(taskId)

    const buttons =
      instruction.kind === 'blocked' && instruction.overflowOffered
        ? [offerButton(taskId)]
        : instruction.kind === 'choice'
          ? choiceButtons(instruction.chooses, conversationKey, instruction.options)
          : []

    const messages = outcomeMessages(instruction)
    for (const [at, text] of messages.entries()) {
      const replyTo = at === 0 ? answering.replyTo : null
      const last = at === messages.length - 1
      await this.#retrying(() =>
        this.#api.post({
          channel: answering.channel,
          text,
          replyTo,
          buttons: last ? buttons : [],
        }),
      )
    }
  }

  async #answeringFor({ conversationKey, caller }: OutboundInstruction): Promise<Answering> {
    const answered = this.#answering.get(addressOf(conversationKey, caller))
    return {
      channel: await this.#place(conversationKey, answered),
      replyTo: answered?.message ?? null,
    }
  }

  #remember(event: DiscordEvent, message: IngressMessage): void {
    const channel = asString(event.message['channel_id'])
    const id = asString(event.message['id'])
    if (channel === null || id === null) return

    const at = addressOf(message.conversationKey, message.caller)
    this.#answering.delete(at)
    if (this.#answering.size >= REMEMBERED) {
      const oldest = this.#answering.keys().next().value
      if (oldest !== undefined) this.#answering.delete(oldest)
    }
    this.#answering.set(at, { channel, message: id, name: threadName(message.text), place: null })
  }

  #place(conversationKey: string, answered: Answered | undefined): Promise<string> {
    if (answered === undefined || answered.channel === conversationKey) {
      return Promise.resolve(conversationKey)
    }
    if (answered.place !== null) return answered.place

    const opening = this.#openThread(conversationKey, answered)
    answered.place = opening
    return opening.catch((error: unknown) => {
      if (answered.place === opening) answered.place = null
      throw error
    })
  }

  async #openThread(conversationKey: string, answered: Answered): Promise<string> {
    try {
      return await this.#retrying(() =>
        this.#api.startThread(answered.channel, conversationKey, answered.name),
      )
    } catch (error) {
      if (!refused(error)) throw error
      this.#log({ event: 'thread-unopened', channel: answered.channel, status: error.status })
      return answered.channel
    }
  }

  async #acknowledge(taskId: string, { channel, replyTo }: Answering, text: string): Promise<void> {
    const posted = this.#acknowledgements.get(taskId)
    if (posted !== undefined) {
      const id = await posted
      await this.#retrying(() => this.#api.edit(channel, id, text))
      return
    }

    const posting = this.#retrying(() => this.#api.post({ channel, text, replyTo, buttons: [] }))
    this.#acknowledgements.set(taskId, posting)
    try {
      await posting
    } catch (error) {
      if (this.#acknowledgements.get(taskId) === posting) this.#acknowledgements.delete(taskId)
      throw error
    }
  }

  async #retrying<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call()
      } catch (error) {
        const wait = attempt < ATTEMPTS ? waitBefore(error, attempt) : null
        if (wait === null) throw error
        await this.#wait(wait)
      }
    }
  }
}

function addressOf(conversationKey: string, caller: string): string {
  return `${conversationKey} ${caller}`
}

function offerButton(taskId: string): DiscordButton {
  return { label: OVERFLOW_BUTTON, customId: overflowId(taskId) }
}

function choiceButtons(
  chooses: Extract<Command, 'model' | 'effort' | 'caveman'>,
  conversationKey: string,
  options: readonly string[],
): readonly DiscordButton[] {
  if (options.length > MAX_BUTTONS) return []
  return options.map((option) => ({
    label: option,
    customId: chooseId(chooses, conversationKey, option),
  }))
}

function refused(error: unknown): error is DiscordRefusal {
  return error instanceof DiscordRefusal && error.status !== 429 && error.status < 500
}

function waitBefore(error: unknown, attempt: number): number | null {
  if (refused(error)) return null
  const asked = error instanceof DiscordRefusal ? error.retryAfterMs : null
  if (asked === null) return Math.min(RETRY_FLOOR_MS * 2 ** (attempt - 1), RETRY_CEILING_MS)
  return asked > RETRY_CEILING_MS ? null : asked
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}
