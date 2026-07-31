/**
 * The three things a person can say that roma answers itself.
 *
 * `stop` ends the Task running now and leaves the Session intact, so the next
 * message can redirect it rather than start over. `clear` gives the
 * Conversation a Session with nothing in it, for when the context has gone
 * stale or wrong. `model` says which model that Session runs on.
 *
 * There are three here, and ADR-0014 moved the number ADR-0003 fixed at two:
 * everything else a person types is work for Claude Code — apart from the few of
 * Claude Code's own commands ADR-0012 relays as a Readout. Three is a count of
 * Commands and not of spellings: ADR-0013 gives the reset three, and that moved
 * no number here.
 *
 * This comment used to say that every Claude Code slash command was passed
 * through as work, and it was never true. What is passed through is the *text*
 * of one: `attributed()` puts the Caller Marker above every message, so what
 * reaches stdin begins with `<from>` and Claude Code — which parses a command
 * only when the message starts with a slash — sees prose. The Turn is real and
 * is billed, and the answer is the model's guess about the command rather than
 * the command. A Readout is the only route by which one of them arrives as
 * itself, and `/model` is why the third Command exists: ADR-0012 measured that
 * shape at `$0.0549` and named `/model` as the string it must never be relayed
 * for.
 */
export type Command = 'stop' | 'clear' | 'model'

/**
 * One Command as it was typed: which one, and what followed it.
 *
 * The argument is null for every Command but `/model`, and for `/model` itself
 * when nothing followed it — which is a request in its own right rather than a
 * malformed one.
 */
export interface CommandRequest {
  readonly command: Command
  /** What followed the head, lowercased like the head. Null where nothing did. */
  readonly argument: string | null
}

/**
 * How each Command is written when it takes nothing. Nothing else is one.
 *
 * The reset answers to three strings, and the ADR-0013 reason is the one
 * `readouts.ts` already gives for carrying `/cost` and `/stats`: a spelling roma
 * leaves unclaimed is one somebody is billed for. `clear` is Claude Code's own
 * name for this and `reset` and `new` are the two aliases it declares on it, so
 * all three are strings a person arrives already typing — and roma held only the
 * alias, which left the name falling to a Task that costs money to answer
 * nothing.
 *
 * `/clear` is the one that mattered, and not for the five cents. Relaying it as
 * a Readout is the obvious repair and is the worst move available: Claude Code's
 * `/clear` moves its process onto a session roma is not tracking, so the next
 * `--resume` resolves to a session roma believes in and Claude Code has left.
 * Being a Command puts it out of reach of that by construction — `readCommand`
 * answers before `readReadout` is consulted — so whitelisting it later would
 * mean deleting it from here first, which is a deliberate act and reads as one.
 *
 * `/model` is here as well as below, because a `/model` with nothing after it is
 * the Command asking roma to report rather than a Caller forgetting the argument.
 *
 * These strings are roma's outright. Nothing is relayed and nothing is compared
 * against Claude Code, so a release that drops `new` from its aliases changes
 * nothing here.
 */
const COMMANDS: Readonly<Record<string, Command>> = {
  '/stop': 'stop',
  '/clear': 'clear',
  '/reset': 'clear',
  '/new': 'clear',
  '/model': 'model',
}

/**
 * The heads that may be followed by an argument, and nothing else may.
 *
 * ADR-0003 rejected prefix matching and the rejection is kept here, narrowed
 * rather than dropped. What it rejected was a *general* rule — "begins with a
 * slash and looks like ours" — and the reason was growth: such a rule inherits
 * every command a later Claude Code release adds. A named list does not grow on
 * its own. It is the Readout whitelist's shape: it fails closed, and adding a
 * string to it is a deliberate act somebody has to write down.
 *
 * The sentence ADR-0003 defended the whole-message rule with — "Neither of roma's
 * two takes an argument, so there is nothing this rule turns away that was meant
 * for roma" — stops being true here. The rule survives it; only the count does
 * not.
 */
const TAKES_AN_ARGUMENT: Readonly<Record<string, Command>> = {
  '/model': 'model',
}

/**
 * Read a message as a Command, or null if it is work.
 *
 * The whole message has to be the Command, or a listed head and exactly one
 * argument. Claude Code has slash commands of its own and roma passes all but a
 * handful of them through — `/compact`, anything a later version adds — so a
 * prefix match would quietly capture commands that are not roma's, and would grow
 * more wrong with every Claude Code release.
 *
 * **One argument, or none.** `/model opus` is somebody choosing a model;
 * `/model the deploy as a state machine` is prose that happens to begin with a
 * word roma claims, and it is work. Claude Code's `/clear` takes a name and
 * roma's reset has nothing to name, so `/clear foo` still falls to a Task and is
 * billed as prose — left open deliberately (ADR-0013), because closing it means
 * deciding what a name would mean to roma.
 *
 * A `/model` whose argument is not on the Menu is still a Command, and is refused
 * as one. Falling through would reproduce the exact fault this exists to fix.
 *
 * Case is ignored because a phone keyboard capitalises the first letter of a
 * message on its own, and `/Stop` is nobody asking for something else. The
 * argument is lowercased with the head for the same reason and because every name
 * on the Menu is lower case, so `/Model Opus` is not a different message.
 */
export function readCommand(text: string): CommandRequest | null {
  const message = text.trim().toLowerCase()

  const whole = COMMANDS[message]
  if (whole !== undefined) return { command: whole, argument: null }

  const [head = '', argument, ...rest] = message.split(/\s+/)
  // Two words after the head are not an argument, they are a sentence. Refusing
  // them here is what keeps a message somebody meant for the agent from being
  // swallowed by a Command that would answer it with a refusal.
  if (argument === undefined || rest.length > 0) return null

  const withArgument = TAKES_AN_ARGUMENT[head]
  return withArgument === undefined ? null : { command: withArgument, argument }
}
