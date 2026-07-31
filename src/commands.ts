/**
 * The two things a person can say that roma answers itself.
 *
 * `stop` ends the Task running now and leaves the Session intact, so the next
 * message can redirect it rather than start over. `clear` gives the
 * Conversation a Session with nothing in it, for when the context has gone
 * stale or wrong.
 *
 * There are two here, and ADR-0003 fixed that number: everything else a person
 * types is work for Claude Code — apart from the few of Claude Code's own
 * commands ADR-0012 relays as a Readout. Two is a count of Commands and not of
 * spellings: ADR-0013 gives the reset three, and that moved no number here.
 *
 * CONTEXT.md says three, and it is ahead of this file rather than wrong: the
 * third is `/model`, which ADR-0014 decided and nothing in `src/` implements
 * yet. Until it does, `/model` is work like any other message.
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
export type Command = 'stop' | 'clear'

/**
 * How each Command is written. Nothing else is a Command.
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
 * These strings are roma's outright. Nothing is relayed and nothing is compared
 * against Claude Code, so a release that drops `new` from its aliases changes
 * nothing here.
 */
const COMMANDS: Readonly<Record<string, Command>> = {
  '/stop': 'stop',
  '/clear': 'clear',
  '/reset': 'clear',
  '/new': 'clear',
}

/**
 * Read a message as a Command, or null if it is work.
 *
 * The whole message has to be the Command. Claude Code has slash commands of its
 * own and roma passes all but a handful of them through — `/model`, anything a
 * later version adds — so a prefix match would quietly capture commands that are
 * not roma's, and would grow more wrong with every Claude Code release. Neither
 * of roma's two takes an argument, so there is nothing this rule turns away that
 * was meant for roma: Claude Code's `/clear` takes a name, roma's reset has
 * nothing to name, and so `/clear foo` falls to a Task and is billed as prose.
 * That is a smaller version of the fault ADR-0013 fixed, left open deliberately
 * — closing it means deciding what a name would mean to roma.
 *
 * Case is ignored because a phone keyboard capitalises the first letter of a
 * message on its own, and `/Stop` is nobody asking for something else.
 */
export function readCommand(text: string): Command | null {
  return COMMANDS[text.trim().toLowerCase()] ?? null
}
