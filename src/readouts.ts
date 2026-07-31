/**
 * The Claude Code commands roma hands over as themselves.
 *
 * A Readout is named by what roma does with it rather than by what it costs
 * (ADR-0012): roma relays it to the Session's process instead of giving it to
 * the model to read. Nothing on this list spends money on the pinned build, but
 * that is the rule for what may go on it — not what the word means. A term
 * defined by one build's behaviour is a term that turns false on somebody else's
 * release, and `shared-window.ts` is already a case of that.
 *
 * **This list is a person's judgement about Claude Code 2.1.220** — the ADR-0007
 * pin, and the build every entry below was measured on. The version is named here
 * so the drift report's working-tree sweep lists this file under what rests on
 * the pin, which is what ADR-0012 left open: "roma now has a list that must be
 * re-audited whenever the ADR-0007 pin moves. Nothing enforces that." It still
 * does not enforce it. What changes is that the re-audit list stops being
 * something somebody has to remember and becomes something the report prints.
 * `src/model-menu.ts` carries the same line for the same reason.
 *
 * **The membership rule: read-only, non-interactive, drives no Turn, changes no
 * state of the Session or of Claude Code.** Applied by a person, and re-applied
 * whenever the ADR-0007 pin moves — nothing in the stream marks a command as
 * read-only, so this cannot be checked by machine. Two of the three ways it can
 * go wrong are caught anyway: an entry that has been removed answers
 * `Unknown command: /x` for free, and an entry that has become model-driven
 * comes back with a Turn on it, which the Core writes to the Operator Log.
 * An entry that stays free and becomes destructive is caught by the re-audit or
 * not at all.
 *
 * A whitelist rather than a denylist, and that is the decision rather than the
 * shortcut. Under a denylist a release that adds a destructive non-interactive
 * command adds it to roma as permitted; under this, the same release adds one
 * that does not work until somebody puts it here. It fails closed. The pool a
 * denylist would have to keep up with is populated and dangerous — `/clear`
 * moves Claude Code to a session roma does not know about, `/model` takes a
 * Session off the model roma believes it is on, `/config` sets anything at all —
 * and every one of those is free and non-interactive on the pinned build.
 *
 * `/clear` is out of reach twice over since ADR-0013, and `/model` since
 * ADR-0014: both are roma's own Commands now, and the Core reads a Command before
 * it consults this list. `/model` is the sharper of the two — relayed, the choice
 * would live in a process that ends at Eviction, so what a Caller would get is a
 * setting that reverts at a moment they cannot see rather than model switching.
 */
const READOUTS: readonly string[] = [
  // Show current context usage: how full this Session's context window is.
  '/context',
  // Show session cost, plan usage, and activity stats — with `/cost` and
  // `/stats`, which Claude Code declares as aliases of it. The aliases are here
  // because leaving them out reproduces exactly the fault ADR-0012 exists to
  // fix, only for two more strings: somebody types `/cost` and is billed for a
  // plausible sentence about what `/cost` would have said.
  '/usage',
  '/cost',
  '/stats',
]

/**
 * Read a message as a Readout, or null if it is not one.
 *
 * The whole message has to be one, for the same reason a Command has to be —
 * and here it also carries the safety of the whole design. Because an exact
 * match is required, what roma puts on the wire is a string from the table
 * above rather than anything a person typed, which is what makes writing the
 * Caller Marker *after* it safe: there is no Caller text for a forged marker to
 * hide in.
 *
 * Case is ignored, and the canonical spelling is what gets sent. A phone
 * keyboard capitalises the first letter of a message on its own, and `/Context`
 * is nobody asking for something else.
 */
export function readReadout(text: string): string | null {
  const candidate = text.trim().toLowerCase()
  return READOUTS.includes(candidate) ? candidate : null
}
