import type { IngressMessage, Quotation } from './channel-adapter.js'
import type { WrittenEnclosure } from './enclosures.js'
import type { RelayRequest } from './relays.js'

/**
 * The marker's two halves. Bounded rather than bare, because `[Ada]` would be
 * indistinguishable from something somebody typed.
 */
const OPEN = '<from>'
const CLOSE = '</from>'

/**
 * One message with the Caller named above it, as Claude Code is given it.
 *
 * A Chat thread is many people sharing one Conversation and therefore one
 * Session (ADR-0008), so without this the Session's whole account of a thread is
 * one voice saying everything — and an agent asked to do what somebody said an
 * hour ago has no way to tell whose "somebody" it is.
 *
 * On **every** Turn, unconditionally, DMs included. The alternative — marking
 * only when the Caller changes — needs the Core to remember who spoke last,
 * which is lost on a restart, and an unmarked message is read as "the same
 * person again": Bob's request would be quietly filed under Ada, in the one
 * record ADR-0006 says roma never deletes. A marker on a DM costs a line.
 *
 * Every message *this* function writes, which is every message given to the
 * model as prose. A Relay carrying an argument is the one message roma sends
 * with no marker anywhere in it, and `relayed` below is where that exception is
 * argued and bounded.
 *
 * The marker rides on the text because there is nowhere else for it to ride. A
 * process serves a whole Session and its environment and arguments are fixed at
 * spawn, which is the argument ADR-0008 already made about the Installation
 * Token; the Caller changes between Turns of that one process, so the per-Turn
 * channel — the line written to stdin — is the only one there is.
 *
 * **roma's part is the tagged prefix, and it comes first.** Anybody who can
 * message roma can type something that looks like a marker, and roma's own goes
 * above whatever they sent. That is a rule about the agent not being confused
 * rather than a privilege boundary: ADR-0008 already establishes that everyone
 * who can reach roma reaches the whole Installation, so there is no privilege
 * here to forge.
 *
 * Said as the tagged prefix rather than as the first line, which is how it read
 * until Enclosures gave the prefix a second tag (ADR-0011). The rule did not
 * weaken — the tags were always what bounded roma's part, and counting lines
 * was shorthand that happened to be exact while there was only one.
 *
 * **A Quotation is why the prefix now contains content, and why that content is
 * escaped.** Until it, everything the model read as content had been typed by
 * the person who sent it, so there was exactly one untrusted region and it ran
 * from the blank line to the end — roma wrote nothing after it, and a forged tag
 * was therefore always behind a genuine one. A quotation is a second untrusted
 * region, and two of them cannot both be last: whichever order they go in, roma
 * writes a tag *between* them, and that tag is the thing a forgery would have to
 * be mistaken for. So the quotation goes inside the prefix and is escaped there
 * (`quoted` below), which leaves the invariant exactly as it was — roma's part
 * is the tagged prefix, it comes first, and the one region roma does not escape
 * is still the last thing in the string (ADR-0021).
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

/**
 * Who somebody else's contribution is from, on the tag that carries it.
 *
 * Absent on nearly all of them and load-bearing on the rest: a forwarded
 * message's attachments land in the same Working Directory on the same kind of
 * tag as the Caller's own, so without this "the screenshot Ada sent" and "the
 * screenshot Ada forwarded from Bob" are one sentence — the misattribution the
 * Caller Marker exists to prevent, one level down (ADR-0021).
 *
 * Nothing is written for the Caller's own; the marker above already says who.
 */
function fromAttribute(from: string | null): string {
  return from === null ? '' : ` from="${attribute(from)}"`
}

/**
 * The Quotation on a message, framed and escaped, under roma's other tags.
 *
 * **The one string roma escapes rather than merely carries**, and it must stay
 * escaped. Everything else the model reads as content is last in the message, so
 * it can say anything and still sit behind roma's tags. This one has roma's text
 * after it, so an unescaped `</quoted>` would end roma's frame early and leave
 * the rest of the quotation reading as though roma had written it.
 *
 * The author is on the tag rather than absent, because a quotation with no
 * author named reads as the Caller saying it themselves.
 */
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
 * A Relay as Claude Code is given it: the command first, and the Caller named
 * below it — or not named at all.
 *
 * The one place the marker does not come first, and the exception is the whole
 * of why roma can relay one of Claude Code's own commands at all. Claude Code
 * recognises a slash command only when the message begins with the slash, so a
 * marker written above one turns it into prose: measured on the pinned build,
 * `<from>…</from>\n\n/context` drives a real Turn and answers with the model's
 * guess about the command, where the same message the other way round returns
 * the command's output for nothing. That is the fault ADR-0012 exists to fix,
 * and it is the reason `attributed` cannot be used here.
 *
 * **Where the Caller supplied no text, the marker follows the command.** Safe
 * only because `readRelay` demands an exact whole-message match there: `command`
 * comes from roma's own table, nothing a person typed follows it, and there is
 * no Caller text for a forged marker to hide in. Attribution is not traded away
 * — Claude Code carries what follows the command into the Transcript as
 * `<command-args><from>…</from></command-args>`, measured — so the Caller is
 * recorded exactly as on a Turn. What moves is where the marker sits, not
 * whether it is kept.
 *
 * **Where the Caller supplied an argument, there is no marker at all** — the
 * only message roma writes without one, and ADR-0018 is where that is argued.
 * The one sentence it rests on:
 *
 * > A Caller Marker says **who sent a message**. A summarisation instruction
 * > says **what to keep**, and what to keep legitimately names other people —
 * > "keep what Bob said about the deploy". Inside one string those two are
 * > indistinguishable, and no ordering separates them.
 *
 * Measured rather than reasoned: given roma's genuine marker first and a second
 * `<from>` behind it, the summariser credited **both**, 3/3, and in one run
 * called both fake. And the misattribution the marker guards against does not
 * arise here — with no marker, 5/5 summaries credited the request to nobody. A
 * summariser is compressing rather than reconstructing who said what.
 *
 * The rule therefore reads backwards — the marker is present when there is no
 * content and absent when there is — and it follows from the same sentence both
 * times. What is lost is the Transcript's record of *who* asked; what is asked
 * is still there verbatim in `<command-args>`, and who asked is on the Audit
 * Record, which is where CONTEXT.md already puts the attribution of spending.
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
