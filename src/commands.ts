/**
 * The seven things a person can say that roma answers itself.
 *
 * `stop` ends the Task running now and leaves the Session intact, so the next
 * message can redirect it rather than start over. `clear` gives the
 * Conversation a Session with nothing in it, for when the context has gone
 * stale or wrong. `model` says which model that Session runs on, `effort` says
 * how hard it is asked to think, `caveman` says how short it is asked to be,
 * `config` says what it is set to and refuses to set anything else, and `usage`
 * says what the deployment has spent this calendar month.
 *
 * There are seven here, and the number has moved four times: ADR-0014 took
 * ADR-0003's two to three, ADR-0016 and ADR-0017 take it to five, ADR-0027
 * takes it to six, and ADR-0030 takes it to seven. Everything else a person
 * types is work for Claude Code — apart from the few of Claude Code's own
 * commands ADR-0012 relays as a Relay. Seven is a count of Commands and not of
 * spellings: ADR-0013 gives the reset three, ADR-0017 gives `/config` two and
 * ADR-0027 gives `usage` three, and none of them moved the number here.
 *
 * This comment used to say that every Claude Code slash command was passed
 * through as work, and it was never true. What is passed through is the *text*
 * of one: `attributed()` puts the Caller Marker above every message, so what
 * reaches stdin begins with `<from>` and Claude Code — which parses a command
 * only when the message starts with a slash — sees prose. The Turn is real and
 * is billed, and the answer is the model's guess about the command rather than
 * the command. A Relay is the only route by which one of them arrives as
 * itself, and `/model` is why the third Command exists: ADR-0012 measured that
 * shape at `$0.0549` and named `/model` as the string it must never be relayed
 * for. `/effort` and `/config` are the same argument twice more — the first
 * because a relayed `/effort` sets something the build itself calls `this
 * session only`, and the second because a relayed `/config key=value` writes a
 * settings file every Session in the deployment shares.
 *
 * `usage` is claimed for a different fault and is the one place the reasoning
 * above does not reach. Relayed, it was free, non-interactive, and answered by
 * the real command rather than by a guess about it — so what it cost was not
 * money but a wrong number, read off counters that belong to a process roma
 * replaces at every Eviction. A wrong number nobody is billed for announces
 * itself to nobody, which is why it outranks the ones that do (ADR-0027).
 *
 * `caveman` is the seventh and **the first claimed spelling that is nobody's
 * build**. Every one above it is Claude Code's own, claimed so that a spelling
 * roma leaves unclaimed does not cost a Turn; this one is a third-party skill's,
 * and a build that has never heard of it would answer `Unknown command` rather
 * than guess — so it is not a relayed spelling roma took back, it is one nothing
 * downstream would ever have answered. What makes it worth claiming is the
 * arrival: somebody who met that skill anywhere else types `/caveman` on their
 * first day here, and unclaimed that is prose above a Caller Marker and a Turn
 * spent on a plausible sentence about a mode roma is already in. Same fault,
 * longer route (ADR-0030).
 */
export type Command = 'stop' | 'clear' | 'model' | 'effort' | 'caveman' | 'config' | 'usage'

/**
 * One Command as it was typed: which one, and what followed it.
 *
 * The argument is null for the three Commands that take none, and for the four
 * that do when nothing followed them — which is a request in its own right
 * rather than a malformed one.
 */
export interface CommandRequest {
  readonly command: Command
  /** What followed the head, lowercased like the head. Null where nothing did. */
  readonly argument: string | null
}

/**
 * Enforced by `fence:relays-no-command-overlap` and by `fence:commands-bare-head-is-a-command`.
 */
const COMMANDS: ReadonlyMap<string, Command> = new Map(
  Object.entries({
    '/stop': 'stop',
    '/clear': 'clear',
    '/reset': 'clear',
    '/new': 'clear',
    '/model': 'model',
    '/effort': 'effort',
    '/caveman': 'caveman',
    '/config': 'config',
    '/settings': 'config',
    '/usage': 'usage',
    '/cost': 'usage',
    '/stats': 'usage',
  }),
)

/** Enforced by `fence:commands-no-prefix-match`. */
const TAKES_AN_ARGUMENT: ReadonlyMap<string, Command> = new Map(
  Object.entries({
    '/model': 'model',
    '/effort': 'effort',
    '/caveman': 'caveman',
    '/config': 'config',
  }),
)

/**
 * Every spelling roma claims, in the order the table declares them.
 *
 * Enforced by `fence:relays-no-command-overlap`.
 */
export function commandSpellings(): readonly string[] {
  return [...COMMANDS.keys()]
}

/**
 * The message that chooses one name off a Menu — what a Caller would have typed,
 * written out for a Channel that let them press it instead (ADR-0023).
 *
 * Here rather than in a Channel because a Command's spelling is this module's.
 *
 * Enforced by `fence:commands-menu-names-round-trip`.
 */
export function commandFor(
  command: Extract<Command, 'model' | 'effort' | 'caveman'>,
  argument: string,
): string {
  return `/${command} ${argument}`
}

/**
 * Read a message as a Command, or null if it is work.
 *
 * The whole message has to be the Command, or a listed head and exactly one
 * argument. `/clear foo` and `/config foo bar` therefore fall to a Task and are
 * billed as prose — left open deliberately (ADR-0013, ADR-0017).
 *
 * A `/model`, `/effort` or `/caveman` whose argument is not on its Menu is still
 * a Command, and is refused as one; so is any `/config` with an argument at all.
 *
 * Case is ignored on the head and on the argument, so `/Model Opus` is not a
 * different message.
 *
 * Enforced by `fence:commands-no-prefix-match` and by `fence:commands-one-argument-or-none`.
 */
export function readCommand(text: string): CommandRequest | null {
  const message = text.trim().toLowerCase()

  const whole = COMMANDS.get(message)
  if (whole !== undefined) return { command: whole, argument: null }

  const [head = '', argument, ...rest] = message.split(/\s+/)
  // Enforced by `fence:commands-one-argument-or-none`.
  if (argument === undefined || rest.length > 0) return null

  const withArgument = TAKES_AN_ARGUMENT.get(head)
  return withArgument === undefined ? null : { command: withArgument, argument }
}
