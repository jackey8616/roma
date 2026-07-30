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
