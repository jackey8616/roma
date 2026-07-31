/**
 * The two things a person can say that roma answers itself.
 *
 * `stop` ends the Task running now and leaves the Session intact, so the next
 * message can redirect it rather than start over. `new` gives the Conversation a
 * Session with nothing in it, for when the context has gone stale or wrong.
 *
 * There are two, and ADR-0003 fixed the number: everything else a person types
 * is work for Claude Code — apart from the few of Claude Code's own commands
 * ADR-0012 relays as a Readout.
 *
 * This comment used to say that every Claude Code slash command was passed
 * through as work, and it was never true. What is passed through is the *text*
 * of one: `attributed()` puts the Caller Marker above every message, so what
 * reaches stdin begins with `<from>` and Claude Code — which parses a command
 * only when the message starts with a slash — sees prose. The Turn is real and
 * is billed, and the answer is the model's guess about the command rather than
 * the command. A Readout is the only route by which one of them arrives as
 * itself.
 */
export type Command = 'stop' | 'new'

/** How each Command is written. Nothing else is a Command. */
const COMMANDS: Readonly<Record<string, Command>> = {
  '/stop': 'stop',
  '/new': 'new',
}

/**
 * Read a message as a Command, or null if it is work.
 *
 * The whole message has to be the Command. Claude Code has slash commands of its
 * own and roma passes every one of them through — `/clear`, `/model`, anything a
 * later version adds — so a prefix match would quietly capture commands that are
 * not roma's, and would grow more wrong with every Claude Code release. Neither
 * of roma's two takes an argument, so there is nothing this rule turns away that
 * was meant for roma.
 *
 * Case is ignored because a phone keyboard capitalises the first letter of a
 * message on its own, and `/Stop` is nobody asking for something else.
 */
export function readCommand(text: string): Command | null {
  return COMMANDS[text.trim().toLowerCase()] ?? null
}
