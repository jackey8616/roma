import type { IngressMessage } from './channel-adapter.js'

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
 * The marker rides on the text because there is nowhere else for it to ride. A
 * process serves a whole Session and its environment and arguments are fixed at
 * spawn, which is the argument ADR-0008 already made about the Installation
 * Token; the Caller changes between Turns of that one process, so the per-Turn
 * channel — the line written to stdin — is the only one there is.
 *
 * **Only the first line is roma's.** Anybody who can message roma can type
 * something that looks like a marker, and roma's own goes above whatever they
 * sent. That is a rule about the agent not being confused rather than a
 * privilege boundary: ADR-0008 already establishes that everyone who can reach
 * roma reaches the whole Installation, so there is no privilege here to forge.
 */
export function attributed({ caller, callerName, text }: IngressMessage): string {
  return `${OPEN}${named(caller, callerName)}${CLOSE}\n\n${text}`
}

/**
 * A Readout with the Caller named *below* it, as Claude Code is given it.
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
 * **Safe only because `readReadout` demands an exact whole-message match.** The
 * rule the marker's placement enforces — see above — is about what follows it
 * being something a person typed. Here nothing follows it and nothing was
 * typed: `command` comes from roma's own table, and a message that was not
 * exactly one of those entries never reaches this function. There is no Caller
 * text for a forged marker to hide in, so being second costs nothing.
 *
 * Attribution is not traded away for it. Claude Code carries what follows the
 * command into the Transcript as the command's arguments —
 * `<command-args><from>…</from></command-args>`, measured — so the Caller is
 * recorded on a Readout exactly as on a Turn. What moves is where the marker
 * sits in the frame, not whether it is kept.
 */
export function attributedReadout(
  { caller, callerName }: Pick<IngressMessage, 'caller' | 'callerName'>,
  command: string,
): string {
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
