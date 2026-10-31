/**
 * The Claude Code commands roma hands over as themselves.
 *
 * **This list is a person's judgement about Claude Code 2.1.220**, the build
 * every entry was measured on, and is re-audited by hand for safety and for cost
 * whenever the pin moves. Naming the version is what lists this file in the
 * drift report. Enforced by `fence:pin-lists-name-the-version`.
 *
 * Nothing in the stream marks a command as safe, so membership is applied by a
 * person. One part is checked by machine: no string here is also a Command.
 * Enforced by `fence:relays-no-command-overlap` and by `fence:relays-whitelist-fails-closed`.
 */

/**
 * What one entry is expected to cost, which decides how it is governed. The
 * Core's drift check is what notices an entry doing otherwise.
 */
export type RelayCost =
  /**
   * Answers locally: no model work, no money, milliseconds. Serialised against
   * its Session, outside the concurrency cap, acknowledged only where it cannot
   * answer at once, and out of `/stop`'s reach.
   */
  | 'free'
  /**
   * Drives a Turn, so it is governed as a Task in every respect: queued, counted
   * against the cap of three, stoppable, Parkable, Overflowable and audited.
   */
  | 'paid'

interface RelayEntry {
  readonly cost: RelayCost
  /**
   * Whether a Caller may put text after the command.
   *
   * False for all but one, and stated on every entry rather than defaulted, so
   * that a string added later has to answer the question instead of inheriting
   * an answer. That is ADR-0003's rejection of prefix matching kept at the
   * smallest scale there is: a *general* "begins with a slash and looks like
   * ours" rule inherits every command a later release adds.
   *
   * Here rather than in a second table keyed on the same strings, because two
   * such tables can disagree — and while they agree, the entry the second one
   * omits leaves a branch in `readRelay` that nothing can reach, which is where
   * a later reader looks for meaning that is not there.
   */
  readonly takesArgument: boolean
}

const RELAYS: ReadonlyMap<string, RelayEntry> = new Map(
  Object.entries({
    // Show current context usage: how full this Session's context window is.
    '/context': { cost: 'free', takesArgument: false },
    '/compact': { cost: 'paid', takesArgument: true },
  }),
)

/** One Relay as it was typed: which command, what followed it, what it costs. */
export interface RelayRequest {
  /** The canonical spelling from the table, which is what goes on the wire. */
  readonly command: string
  /**
   * What followed the head, **verbatim**: case, newlines and all. Null where
   * nothing did. Unlike a Command's argument, roma neither validates nor
   * inspects it.
   */
  readonly argument: string | null
  readonly cost: RelayCost
}

/**
 * Read a message as a Relay, or null if it is not one.
 *
 * Either the whole message is an entry, or it is an argument-taking head and
 * everything after the first run of whitespace is its argument. Case is ignored
 * on the head, and the canonical spelling is what gets sent. The argument is
 * left exactly as it was typed.
 *
 * Enforced by `fence:relays-argument-verbatim`.
 */
export function readRelay(text: string): RelayRequest | null {
  const message = text.trim()

  const spelling = message.toLowerCase()
  const whole = entryFor(spelling)
  if (whole !== undefined) return { command: spelling, argument: null, cost: whole.cost }

  // The first run of whitespace ends the head; every character after it is the
  // argument. `[\s\S]` rather than `.` so a multi-line instruction survives —
  // Claude Code splits the same way and carries the inner newlines through to
  // the summariser, measured.
  const split = /^(\S+)\s+([\s\S]+)$/.exec(message)
  if (split === null) return null
  const command = (split[1] ?? '').toLowerCase()
  const head = entryFor(command)
  if (head === undefined || !head.takesArgument) return null

  return { command, argument: split[2] ?? '', cost: head.cost }
}

/** One entry of the table. Enforced by `fence:table-lookup-ignores-the-prototype`. */
function entryFor(spelling: string): RelayEntry | undefined {
  return RELAYS.get(spelling)
}

/**
 * Every spelling on the list, in the order the table declares them. For the
 * checks that must read the real table rather than a copy.
 */
export function relaySpellings(): readonly string[] {
  return [...RELAYS.keys()]
}
