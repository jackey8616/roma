import type { IngressMessage, PendingEnclosure, Quotation } from '../../channel-adapter.js'
import { commandFor, type Command } from '../../commands.js'
import { reasonOf, type OperatorLog } from '../../operator-log.js'

export type DiscordMessage = Readonly<Record<string, unknown>>

export interface DiscordEvent {
  readonly message: DiscordMessage
  readonly self: string
  readonly guildChannel: boolean
  readonly quotation: Quotation | null
  readonly press: DiscordPress | null
}

export interface DiscordPress {
  readonly caller: string
  readonly callerName: string | null
  readonly customId: string
}

export interface Interaction {
  readonly id: string
  readonly token: string
  readonly message: DiscordMessage
  readonly press: DiscordPress
}

const MESSAGE_COMPONENT = 3

export const MAX_CUSTOM_ID = 100

const CHOOSE = 'choose'
const TAKE_OVERFLOW = 'overflow'

const FIELD = ':'

export type Pressed =
  | {
      readonly kind: typeof CHOOSE
      readonly chooses: Extract<Command, 'model' | 'effort' | 'caveman'>
      readonly conversationKey: string
      readonly option: string
    }
  | { readonly kind: typeof TAKE_OVERFLOW; readonly taskId: string }

export function chooseId(
  chooses: Extract<Command, 'model' | 'effort' | 'caveman'>,
  conversationKey: string,
  option: string,
): string {
  return pressId({ kind: CHOOSE, chooses, conversationKey, option })
}

export function overflowId(taskId: string): string {
  return pressId({ kind: TAKE_OVERFLOW, taskId })
}

function pressId(pressed: Pressed): string {
  return pressed.kind === CHOOSE
    ? [CHOOSE, pressed.chooses, pressed.conversationKey, pressed.option].join(FIELD)
    : [TAKE_OVERFLOW, pressed.taskId].join(FIELD)
}

export function readPress(customId: string): Pressed | null {
  const [tag, ...rest] = customId.split(FIELD)
  switch (tag) {
    case CHOOSE:
      return chosen(rest)
    case TAKE_OVERFLOW:
      return taken(rest)
    default:
      return null
  }
}

function chosen([chooses, conversationKey, ...rest]: readonly string[]): Pressed | null {
  if (chooses !== 'model' && chooses !== 'effort' && chooses !== 'caveman') return null
  if (conversationKey === undefined || conversationKey === '') return null
  const option = rest.join(FIELD)
  return option === '' ? null : { kind: CHOOSE, chooses, conversationKey, option }
}

function taken(rest: readonly string[]): Pressed | null {
  const taskId = rest.join(FIELD)
  return taskId === '' ? null : { kind: TAKE_OVERFLOW, taskId }
}

export function readInteraction(payload: Readonly<Record<string, unknown>>): Interaction | null {
  if (asNumber(payload['type']) !== MESSAGE_COMPONENT) return null

  const id = asString(payload['id'])
  const token = asString(payload['token'])
  const customId = asString(asRecord(payload['data'])?.['custom_id'])
  const message = asRecord(payload['message'])
  const user = asRecord(asRecord(payload['member'])?.['user']) ?? asRecord(payload['user'])
  const caller = asString(user?.['id'])
  if (id === null || token === null || customId === null || message === null || caller === null) {
    return null
  }

  return { id, token, message, press: { caller, callerName: displayName(user), customId } }
}

export type DownloadAttachment = (url: string) => Promise<Uint8Array>

export type FetchMessage = (channelId: string, messageId: string) => Promise<DiscordMessage>

export type DiscordEventLogRecord = {
  readonly event: 'quote-unfetched'
  readonly reason: string
}

export interface ReadOptions {
  readonly download?: DownloadAttachment
}

export function readIngressMessage(
  event: DiscordEvent,
  { download }: ReadOptions = {},
): IngressMessage | null {
  const { message, self, guildChannel, quotation } = event

  const author = asRecord(message['author'])
  const caller = asString(author?.['id'])
  if (caller === null) return null
  if (author?.['bot'] === true || message['webhook_id'] !== undefined) return null

  const channelId = asString(message['channel_id'])
  const messageId = asString(message['id'])
  if (channelId === null || messageId === null) return null

  const guildId = asString(message['guild_id'])
  if (guildId !== null && !addressed(message, self)) return null

  const conversationKey = guildChannel ? messageId : channelId

  const text = withoutMention(asString(message['content']) ?? '', self)
  const enclosures = readEnclosures(message, download)
  if (text === '' && enclosures.length === 0 && quotation === null) return null

  return {
    conversationKey,
    caller,
    callerName: displayName(author),
    text,
    enclosures,
    quotation,
  }
}

export function readChosenOption(event: DiscordEvent): IngressMessage | null {
  const { press } = event
  if (press === null) return null
  const pressed = readPress(press.customId)
  if (pressed?.kind !== CHOOSE) return null

  return {
    conversationKey: pressed.conversationKey,
    caller: press.caller,
    callerName: press.callerName,
    text: commandFor(pressed.chooses, pressed.option),
    enclosures: [],
    quotation: null,
  }
}

export function readOverflowTaken(event: DiscordEvent): string | null {
  const { press } = event
  if (press === null) return null
  const pressed = readPress(press.customId)
  return pressed?.kind === TAKE_OVERFLOW ? pressed.taskId : null
}

export async function completedQuotation(
  message: DiscordMessage,
  { fetchMessage, log }: CompleteOptions,
): Promise<Quotation | null> {
  const forwarded = asRecord(asRecord(first(message['message_snapshots']))?.['message'])
  const forwardedText = words(forwarded?.['content'])
  if (forwardedText !== null) return { text: forwardedText, author: null }

  const referenced = asRecord(message['referenced_message'])
  const referencedText = words(referenced?.['content'])
  if (referencedText !== null) {
    return { text: referencedText, author: displayName(asRecord(referenced?.['author'])) }
  }

  const reference = asRecord(message['message_reference'])
  const quotedId = asString(reference?.['message_id'])
  if (quotedId === null) return null
  const quotedIn = asString(reference?.['channel_id']) ?? asString(message['channel_id'])
  if (quotedIn === null) return null

  try {
    const quoted = await fetchMessage(quotedIn, quotedId)
    const text = words(quoted['content'])
    return text === null ? null : { text, author: displayName(asRecord(quoted['author'])) }
  } catch (error) {
    log?.({ event: 'quote-unfetched', reason: reasonOf(error) })
    return null
  }
}

export interface CompleteOptions {
  readonly fetchMessage: FetchMessage
  readonly log?: OperatorLog<DiscordEventLogRecord>
}

function addressed(message: DiscordMessage, self: string): boolean {
  const mentions = message['mentions']
  const named =
    Array.isArray(mentions) && mentions.some((user) => asString(asRecord(user)?.['id']) === self)
  const content = asString(message['content']) ?? ''
  return named || mentionsOf(self).some((mention) => content.includes(mention))
}

function withoutMention(content: string, self: string): string {
  return mentionsOf(self)
    .reduce((text, mention) => text.replaceAll(mention, ''), content)
    .trim()
}

function mentionsOf(id: string): readonly string[] {
  return [`<@${id}>`, `<@!${id}>`]
}

function readEnclosures(
  message: DiscordMessage,
  download: DownloadAttachment | undefined,
): readonly PendingEnclosure[] {
  const attachments = message['attachments']
  if (!Array.isArray(attachments) || download === undefined) return []

  const enclosures: PendingEnclosure[] = []
  for (const entry of attachments) {
    const attachment = asRecord(entry)
    const url = asString(attachment?.['url'])
    if (url === null) continue
    const name = asString(attachment?.['filename']) ?? 'attachment'
    enclosures.push({ name, from: null, redeem: () => download(url) })
  }
  return enclosures
}

function displayName(user: Readonly<Record<string, unknown>> | null | undefined): string | null {
  return asString(user?.['global_name']) ?? asString(user?.['username'])
}

function words(value: unknown): string | null {
  const text = (asString(value) ?? '').trim()
  return text === '' ? null : text
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : null
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
