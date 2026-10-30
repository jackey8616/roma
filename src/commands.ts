export type Command = 'stop' | 'clear' | 'model' | 'effort' | 'caveman' | 'config' | 'usage'

/**
 * One Command as it was typed: which one, and what followed it. The argument is
 * null for the Commands that take none, and for the others when nothing followed
 * them, which is a request in its own right rather than a malformed one.
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
 * billed as prose.
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
