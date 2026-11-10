import type { IngressMessage, Quotation } from './channel-adapter.js'
import type { WrittenEnclosure } from './enclosures.js'
import type { RelayRequest } from './relays.js'

const OPEN = '<from>'
const CLOSE = '</from>'

export function attributed(
  { caller, callerName, text, quotation }: IngressMessage,
  enclosures: readonly WrittenEnclosure[] = [],
): string {
  return `${OPEN}${named(caller, callerName)}${CLOSE}${enclosed(enclosures)}${quoted(quotation)}\n\n${text}`
}

function enclosed(enclosures: readonly WrittenEnclosure[]): string {
  return enclosures
    .map(
      ({ path, name, from }) =>
        `\n<enclosure path="${path}" name="${attribute(name)}"${fromAttribute(from)} />`,
    )
    .join('')
}

function fromAttribute(from: string | null): string {
  return from === null ? '' : ` from="${attribute(from)}"`
}

function quoted(quotation: Quotation | null): string {
  if (quotation === null) return ''
  const { text, author } = quotation
  return `\n<quoted${fromAttribute(author)}>${content(text)}</quoted>`
}

function content(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function attribute(value: string): string {
  return content(value).replaceAll('"', '&quot;')
}

export function relayed(
  { caller, callerName }: Pick<IngressMessage, 'caller' | 'callerName'>,
  { command, argument }: Pick<RelayRequest, 'command' | 'argument'>,
): string {
  if (argument !== null) return `${command}\n\n${argument}`
  return `${command}\n\n${OPEN}${named(caller, callerName)}${CLOSE}`
}

function named(caller: string, callerName: string | null): string {
  if (callerName === null || callerName.trim() === '') return caller
  return `${callerName} (${caller})`
}
