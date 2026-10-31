import type { IngressMessage, Quotation } from './channel-adapter.js'
import type { WrittenEnclosure } from './enclosures.js'
import type { RelayRequest } from './relays.js'

const OPEN = '<from>'
const CLOSE = '</from>'

/**
 * One message with the Caller Marker above it, as Claude Code is given it: every
 * message given to the model as prose. A Quotation goes inside roma's tagged
 * prefix, escaped; what was typed comes last and is not escaped.
 *
 * On **every** Turn, unconditionally, DMs included. Enforced by
 * `fence:attribution-marks-every-turn`.
 */
export function attributed(
  { caller, callerName, text, quotation }: IngressMessage,
  enclosures: readonly WrittenEnclosure[] = [],
): string {
  return `${OPEN}${named(caller, callerName)}${CLOSE}${enclosed(enclosures)}${quoted(quotation)}\n\n${text}`
}

/**
 * The Enclosures on a message, named to the agent one tag to a line.
 *
 * Under the Caller Marker and above what was typed — roma's part of the frame is
 * the tagged prefix and must come first (see `attributed`). A forged tag buys
 * nothing: everyone sharing a Conversation shares one Session and one Working
 * Directory, so it names a file they could have asked for in prose (ADR-0008,
 * ADR-0011).
 */
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

// Enforced by `fence:attribution-quotation-escaped`.
function quoted(quotation: Quotation | null): string {
  if (quotation === null) return ''
  const { text, author } = quotation
  return `\n<quoted${fromAttribute(author)}>${content(text)}</quoted>`
}

/**
 * One element's content, escaped enough that nothing inside it can parse as a
 * tag roma wrote.
 *
 * Three replacements rather than four: a quote is harmless between tags, and
 * escaping it would turn every quotation of somebody saying "hello" into
 * `&quot;hello&quot;` for nothing. `attribute` adds the fourth, where it is not
 * harmless.
 */
function content(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * One attribute value, escaped enough to stay one.
 *
 * The sender chose this string and a filename may contain a quote, which
 * unescaped would end the attribute early and leave the rest reading as markup
 * roma wrote.
 *
 * `callerName` is deliberately not escaped this way — it comes from the
 * Channel's directory of people rather than from an upload (ADR-0009). Escaping
 * goes where the string was chosen by whoever sent the message.
 */
function attribute(value: string): string {
  return content(value).replaceAll('"', '&quot;')
}

/**
 * A Relay as Claude Code is given it: the command first, then the Caller Marker
 * where the Caller supplied no text, and no marker at all where they supplied an
 * argument.
 *
 * The one place the marker does not come first. Enforced by
 * `fence:attribution-relay-command-first`.
 */
export function relayed(
  { caller, callerName }: Pick<IngressMessage, 'caller' | 'callerName'>,
  { command, argument }: Pick<RelayRequest, 'command' | 'argument'>,
): string {
  if (argument !== null) return `${command}\n\n${argument}`
  return `${command}\n\n${OPEN}${named(caller, callerName)}${CLOSE}`
}

/**
 * Who the marker says asked.
 *
 * A blank name is no name. A Channel is entitled to hand over one — Chat's own
 * User resource has `isAnonymous`, and `displayName` is not on every delivery —
 * and rendering it literally would produce a marker that reads as roma being
 * broken rather than as somebody roma has no name for.
 */
function named(caller: string, callerName: string | null): string {
  if (callerName === null || callerName.trim() === '') return caller
  return `${callerName} (${caller})`
}
