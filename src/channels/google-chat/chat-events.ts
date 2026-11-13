import type {
  IngressMessage,
  OutboundInstruction,
  PendingEnclosure,
  Quotation,
} from '../../channel-adapter.js'
import { commandFor } from '../../commands.js'
import type { OperatorLog } from '../../operator-log.js'

export type DownloadAttachment = (resourceName: string) => Promise<Uint8Array>

export type ChatEventLogRecord =
  | {
      readonly event: 'quote-unread'
      readonly keys: readonly string[]
    }
  | {
      readonly event: 'attachment-unread'
      readonly keys: readonly string[]
    }

export type ChatEvent = Readonly<Record<string, unknown>>

const DIRECT_MESSAGE = 'DIRECT_MESSAGE'
const DM = 'DM'

export function readIngressMessage(
  event: ChatEvent,
  { download, log }: ReadOptions = {},
): IngressMessage | null {
  if (asString(event['type']) !== 'MESSAGE') return null

  const message = asRecord(event['message'])
  if (message === null) return null
  const sender = asRecord(message['sender'])
  const caller = asString(sender?.['name'])
  if (caller === null || asString(sender?.['type']) === 'BOT') return null
  const callerName = asString(sender?.['displayName'])

  const conversationKey = conversationKeyOf(event, message)
  if (conversationKey === null) return null

  const text = (asString(message['argumentText']) ?? asString(message['text']) ?? '').trim()
  const quotation = readQuotation(message, log)
  const enclosures = readEnclosures(message, download, log)
  if (text === '' && enclosures.length === 0 && quotation === null) return null

  return {
    conversationKey,
    caller,
    callerName,
    text,
    enclosures,
    quotation,
  }
}

function conversationKeyOf(
  event: ChatEvent,
  message: Readonly<Record<string, unknown>>,
): string | null {
  const space = asRecord(event['space']) ?? asRecord(message['space'])
  const spaceName = asString(space?.['name'])
  if (spaceName === null) return null

  const direct =
    asString(space?.['spaceType']) === DIRECT_MESSAGE || asString(space?.['type']) === DM
  const thread = asString(asRecord(message['thread'])?.['name'])
  if (!direct && thread === null) return null

  return direct || thread === null ? spaceName : thread
}

function readQuotation(
  message: Readonly<Record<string, unknown>>,
  log: OperatorLog<ChatEventLogRecord> | undefined,
): Quotation | null {
  const metadata = asRecord(message['quotedMessageMetadata'])
  if (metadata === null) return null

  const snapshot = asRecord(metadata['quotedMessageSnapshot'])
  const text = (asString(snapshot?.['text']) ?? '').trim()
  const quotation = text === '' ? null : { text, author: asString(snapshot?.['sender']) }

  if (quotation === null) {
    log?.({
      event: 'quote-unread',
      keys: [
        ...Object.keys(metadata),
        ...(snapshot === null
          ? []
          : Object.keys(snapshot).map((key) => `quotedMessageSnapshot.${key}`)),
      ],
    })
  }

  return quotation
}

export interface ReadOptions {
  readonly download?: DownloadAttachment
  readonly log?: OperatorLog<ChatEventLogRecord>
}

function readEnclosures(
  message: Readonly<Record<string, unknown>>,
  download: DownloadAttachment | undefined,
  log: OperatorLog<ChatEventLogRecord> | undefined,
): readonly PendingEnclosure[] {
  const attachments = message['attachment'] ?? message['attachments']
  if (!Array.isArray(attachments) || attachments.length === 0) return []

  const enclosures: PendingEnclosure[] = []
  for (const entry of attachments) {
    const attachment = asRecord(entry)
    if (attachment === null) continue
    const name = asString(attachment['contentName']) ?? asString(attachment['name']) ?? 'attachment'

    const resourceName = asString(asRecord(attachment['attachmentDataRef'])?.['resourceName'])
    if (resourceName !== null && download !== undefined) {
      enclosures.push({ name, from: null, redeem: () => download(resourceName) })
      continue
    }

    const driveFileId = asString(asRecord(attachment['driveDataRef'])?.['driveFileId'])
    if (driveFileId !== null) {
      enclosures.push({
        name,
        from: null,
        redeem: () =>
          Promise.reject(
            new Error(
              `${name} is a Google Drive file, and roma can only read files uploaded to the conversation`,
            ),
          ),
      })
    }
  }

  if (enclosures.length === 0) {
    log?.({
      event: 'attachment-unread',
      keys: [...new Set(attachments.flatMap((entry) => Object.keys(asRecord(entry) ?? {})))],
    })
  }

  return enclosures
}

const CARD_CLICKED = 'CARD_CLICKED'
export const TAKE_OVERFLOW = 'takeOverflow'
export const TASK_ID_PARAMETER = 'taskId'

export const CHOOSE = 'choose'
export const CHOOSES_PARAMETER = 'chooses'
export const OPTION_PARAMETER = 'option'

export function readOverflowTaken(event: ChatEvent): string | null {
  return pressed(event, TAKE_OVERFLOW, TASK_ID_PARAMETER)
}

export function readChosenOption(event: ChatEvent): IngressMessage | null {
  const chooses = pressed(event, CHOOSE, CHOOSES_PARAMETER)
  const option = pressed(event, CHOOSE, OPTION_PARAMETER)
  if (chooses === null || option === null) return null
  if (!isMenu(chooses)) return null

  const user = asRecord(event['user'])
  const caller = asString(user?.['name'])
  if (caller === null) return null

  const message = asRecord(event['message'])
  if (message === null) return null
  const conversationKey = conversationKeyOf(event, message)
  if (conversationKey === null) return null

  return {
    conversationKey,
    caller,
    callerName: asString(user?.['displayName']),
    text: commandFor(chooses, option),
    enclosures: [],
    quotation: null,
  }
}

type Menu = Extract<OutboundInstruction, { kind: 'choice' }>['chooses']

const MENUS: Readonly<Record<Menu, true>> = { model: true, effort: true, caveman: true }

function isMenu(name: string): name is Menu {
  return Object.hasOwn(MENUS, name)
}

function pressed(event: ChatEvent, action: string, parameter: string): string | null {
  if (asString(event['type']) !== CARD_CLICKED) return null

  const common = asRecord(event['common'])
  if (asString(common?.['invokedFunction']) === action) {
    const value = asString(asRecord(common?.['parameters'])?.[parameter])
    if (value !== null) return value
  }

  const legacy = asRecord(event['action'])
  if (asString(legacy?.['actionMethodName']) !== action) return null
  const parameters = legacy?.['parameters']
  if (!Array.isArray(parameters)) return null
  for (const entry of parameters) {
    const pair = asRecord(entry)
    if (asString(pair?.['key']) === parameter) return asString(pair?.['value'])
  }
  return null
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Readonly<Record<string, unknown>>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
