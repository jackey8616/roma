import type { IngressMessage } from './channel-adapter.js'
import type { WrittenEnclosure } from './enclosures.js'
import type { RelayRequest } from './relays.js'

/**
 * The marker's two halves.
 *
 * Bounded rather than bare — `[Ada]` would be indistinguishable from something
 * somebody typed — and short enough that a Turn is not mostly ceremony.
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
 */
export function attributed(
  { caller, callerName, text }: IngressMessage,
  enclosures: readonly WrittenEnclosure[] = [],
): string {
  return `${OPEN}${named(caller, callerName)}${CLOSE}${enclosed(enclosures)}\n\n${text}`
}

/**
 * The Enclosures on a message, named to the agent one tag to a line.
 *
 * Under the Caller Marker and above what was typed, which is what makes the
 * rule statable: roma's part of the frame is the tagged prefix and comes first.
 * That was always what "only the first line is roma's" meant — see `attributed`
 * — and a second tag is what stops the shorthand being usable, not what stops
 * it being true. Anybody can type a line that looks like one of these, and it
 * buys them nothing: everyone sharing a Conversation shares one Session and one
 * Working Directory, so a forged tag names a file they could have asked for in
 * prose (ADR-0008, ADR-0011).
 *
 * The written Enclosures rather than the pending ones, because by here the
 * bytes are on disk and the path is the only thing worth saying.
 */
function enclosed(enclosures: readonly WrittenEnclosure[]): string {
  return enclosures
    .map(({ path, name }) => `\n<enclosure path="${path}" name="${attribute(name)}" />`)
    .join('')
}

/**
 * One attribute value, escaped enough to stay one.
 *
 * The sender chose this string and a filename may contain a quote, so an
 * unescaped one would end the attribute early and leave the rest of somebody's
 * filename reading as markup roma wrote. Not a privilege boundary — there is
 * none here to cross — but a tag that parses as what it is costs four
 * replacements, and a mangled one is a frame the agent has to guess at.
 *
 * `callerName` is deliberately not escaped this way: it comes from the
 * Channel's own directory of people rather than from an upload, and ADR-0009
 * settled its shape. Escaping is applied where the string was chosen by whoever
 * sent the message.
 */
function attribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
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
