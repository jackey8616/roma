import type { OutboundInstruction, TaskProgress } from '../../channel-adapter.js'
import type { Command } from '../../commands.js'

/**
 * Discord's limit on the text of one message.
 *
 * Not advisory: the API rejects a longer one, so a Turn that wrote more than
 * this arrives as several messages or not at all. Less than half of Chat's,
 * which is what makes splitting the ordinary case here rather than the long
 * tail — how many messages the recorded generating Turn becomes is asserted in
 * `discord-channel.test.ts`, because a number in prose goes stale in silence.
 *
 * **Read everywhere and not found in Discord's own reference** — ADR-0029's
 * second tier of verification, where every secondary source states 2000 and the
 * section read gave no number. Being wrong about it *high* is a message Discord
 * refuses whole, which is a long answer that reaches nobody, so this is the one
 * number in this Channel worth checking against a real guild first.
 */
export const MAX_TEXT = 2000

/**
 * What the button that takes Overflow says.
 *
 * It says that it costs money, because that is the whole of the decision being
 * asked for: ADR-0002 has the valve off by default precisely so that spending is
 * something somebody chooses, and a button labelled "Run anyway" would be that
 * choice made by somebody who did not know they were making it.
 *
 * Chat's word for word, and that is the argument being shared rather than a
 * constant: what the offer costs reads the same wherever it is drawn, and two
 * Channels wording one decision differently would be two decisions.
 */
export const OVERFLOW_BUTTON = 'Run it on metered billing'

/**
 * How long the name of a thread roma opens may be.
 *
 * **Never let a name past it.** Discord refuses the creation, and a refused
 * thread costs the Conversation the Session its key was minted for (ADR-0029) —
 * so a limit that looks cosmetic is the one that loses a Session.
 */
const MAX_THREAD_NAME = 100

/**
 * Everything the Core can say about a Task except that it is still going.
 *
 * Its own type for `render.ts`'s reason in Chat: an outcome is a new message and
 * progress edits one that already exists, and an outcome can be several messages
 * while progress is always exactly one.
 */
type NotProgress<T> = T extends { readonly kind: 'progress' } ? never : T
export type TaskOutcome = NotProgress<OutboundInstruction>

/**
 * How a Task's outcome reads in Discord.
 *
 * Wording is the Channel's business: the Core hands over facts — stopped,
 * nothing to stop, this text — because it cannot see the result of any sentence
 * it might write. The exception is a failure, whose reason the Core does write
 * and this passes through, since it is one sentence that reads the same on every
 * Channel.
 *
 * One message per string, in the order they should be posted. More than one when
 * what has to be said is longer than Discord will take.
 *
 * **Nothing here addresses the Caller in words.** Chat prefixes every piece with
 * an @-mention because a mention is what Chat has; Discord answers the Caller's
 * own message instead, which is the idiomatic form, costs nothing out of the
 * limit, and is therefore the Adapter's to put on the first message and no other
 * (ADR-0029).
 */
export function outcomeMessages(instruction: TaskOutcome): string[] {
  switch (instruction.kind) {
    case 'result': {
      // Its own message or messages, never the acknowledgement edited one last
      // time — the rule ADR-0003 makes unconditional, and the one Discord's
      // search and its quote-reply both depend on: neither reaches anything that
      // is not the content of a message somebody can point at.
      const messages = split(instruction.text, MAX_TEXT)
      // Its own message rather than appended to the answer, because the answer
      // is what gets quoted later and a price tag inside it is quoted with it
      // (ADR-0002).
      if (instruction.overflowCostUsd !== undefined) {
        messages.push(overflowSpentText(instruction.overflowCostUsd))
      }
      return messages
    }
    case 'failure':
      // Split like a result, because it is one: a failed Turn's reason is the
      // Turn's own text, and Discord refuses a long one whole — which would tell
      // the Conversation nothing at all about a Task that is already dead.
      return split(instruction.reason, MAX_TEXT)
    case 'choice':
      // Only the text, and the buttons are the Adapter's: the Menu is one offer
      // with two ways to reach it, so the sentence names every name whether or
      // not anything drew it (ADR-0023). What that keeps is a `choice` splitting
      // like a result — the words are the answer, and the shortcut goes under
      // the last piece of them.
      return split(instruction.text, MAX_TEXT)
    case 'stopped':
      return ['Stopped.']
    case 'command-outcome':
      return [commandText(instruction.command, instruction.carriedOut)]
    case 'blocked':
      // `overflowOffered` is the Adapter's and says nothing here, which is not
      // an omission: the offer is a button, and a sentence beside it would have
      // to name a Command roma has deliberately never had — taking Overflow is
      // the one thing in roma nobody can do by typing (ADR-0002, ADR-0023).
      return [blockedText(instruction.resetsAt)]
    case 'context-full':
      // The consequence rather than the cause, and naming the remedy and what it
      // costs — Chat's `outcomeMessages` is where that wording is argued, and the
      // argument is the Core's fact rather than either Channel's.
      return [
        'Claude cannot shorten this conversation any further, so it cannot take another ' +
          'message. Send /clear to start a fresh session — nothing from this one carries over.',
      ]
    case 'overflow-refused':
      // What they can still do is the point: the Task is not over, and telling
      // them only that they were refused would read as one that is.
      return [
        `Overflow is capped at $${money(instruction.capUsd)} a month and this month has ` +
          `spent $${money(instruction.spentUsd)}, so it is off until the month turns. ` +
          `Your task is still waiting for the shared quota to reset.`,
      ]
  }
}

/**
 * What the thread roma opens from a top-level message is called.
 *
 * The Caller's own first line, because that is what somebody scanning a
 * channel's thread list is reading and roma has nothing better to name it with.
 * A message with no words in it — a pasted screenshot — leaves roma's own name,
 * which is at least true.
 */
export function threadName(text: string): string {
  const [first = ''] = text.trim().split('\n')
  return first.trim() === '' ? 'roma' : fitted(first.trim(), MAX_THREAD_NAME)
}

/** What a blocked Task's message says: the event's own reset time, and that the Task is kept. */
function blockedText(resetsAt: number): string {
  const at = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return `The shared Claude quota is spent. It comes back at ${at} UTC — I have kept your task and will run it then.`
}

/** What an Overflow Turn spent, to the cent it was billed in. */
function overflowSpentText(costUsd: number | null): string {
  // Never "$0.00" for a null: that reports money as free, which is the one claim
  // the Audit Record refuses to make about a Turn nothing priced.
  if (costUsd === null) return 'Ran on metered billing. What it cost was never reported.'
  return `Ran on metered billing: $${money(costUsd)}.`
}

/** Money as people read it, which is two decimal places and no more. */
function money(usd: number): string {
  return usd.toFixed(2)
}

/**
 * The acknowledgement's text for one phase.
 *
 * Deliberately short. This message is edited every few seconds while a Task
 * runs, so it is read at a glance and never read twice — everything worth
 * keeping is in the result.
 */
export function progressText(progress: TaskProgress): string {
  return fitted(phrase(progress), MAX_TEXT)
}

/**
 * Some text inside a budget, with the end taken off where it does not fit.
 *
 * Chat's `fitted`, at Discord's numbers and for its two arguments: a guard on
 * the finished string is the one the next phase cannot forget to ask for, and
 * #75 is what the last unguarded one cost.
 */
function fitted(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget < 1) return ''
  // Clamped because a negative length reads from the *end* in JavaScript, which
  // is the one input that would turn this from a trim into its own opposite.
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

/** How much of a tool's command the acknowledgement quotes. See Chat's. */
const MAX_TOOL_CHARS = 120

/** The acknowledgement's words, with only the tool's own length to bound. */
function phrase(progress: TaskProgress): string {
  switch (progress.phase) {
    case 'queued':
      // The count includes this Task, so 1 means nothing is ahead of it. Said as
      // a number of waiting Tasks rather than as a position, because a Task
      // whose Session is busy is stepped over: this is the size of the backlog,
      // not a place in a running order.
      return progress.position === 1 ? 'Queued.' : `Queued — ${progress.position} waiting.`
    case 'working':
      return 'Working…'
    case 'compacting':
      // Claude Code's own word for it, and the one the person typed if they
      // asked for this. Nothing about how far along: the figures arrive with the
      // boundary, which is the moment it is over.
      return 'Compacting…'
    case 'thinking':
      return `Thinking… (~${progress.estimatedTokens} tokens)`
    case 'tool':
      // Cut mid-character, against the example `split` sets below: `Running rm
      // -rf…` reads as a whole command where `Running rm -rf /home/user/proj…`
      // is visibly severed. A clean edge is the point when trimming prose and
      // the lie when quoting a command.
      return `Running ${progress.tool.slice(0, MAX_TOOL_CHARS)}…`
    case 'writing':
      // Never the prose: shown here it says what the Result is about to say,
      // seconds later and one message down (ADR-0010). The number is what is
      // left, and it is what keeps a writing Turn from reading as a dead one.
      return `Writing… (${progress.characters} chars)`
  }
}

/** What a Command did, in the two words a person can act on. */
function commandText(command: Command, carriedOut: boolean): string {
  if (command === 'clear') return 'Started a fresh session. Nothing from before this is in it.'
  // Two messages for one `/stop` and both earn their place: this answers whoever
  // typed it, and the Task's own "Stopped." lands on the message they watched.
  return carriedOut ? 'Stopping…' : 'Nothing to stop.'
}

/**
 * One answer as the messages Discord will accept, broken at a blank line, then a
 * line ending, then a space.
 *
 * **Not shared with Chat's `split`, deliberately.** That one folds the
 * @-mention in *before* it measures, because a mention added after the split is
 * what pushes the first message past the limit — so a common function would
 * carry a prefix one caller always passes empty, generalising the one thing
 * ADR-0029 says does not generalise. When a third Channel splits, there will be
 * evidence.
 */
function split(text: string, budget: number): string[] {
  // A Turn can finish having written nothing. Posting nothing at all would make
  // it indistinguishable from a Task that died.
  if (text.trim() === '') return ['(roma finished without saying anything.)']

  const messages: string[] = []
  let rest = text
  while (rest.length > budget) {
    const window = rest.slice(0, budget)
    const at = breakPoint(window, budget)
    messages.push(window.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest !== '') messages.push(rest)
  return messages
}

/** Where to cut a full window: the last paragraph, line, or word boundary in it. */
function breakPoint(window: string, budget: number): number {
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(boundary)
    // Not right at the start: a boundary in the first few characters would make
    // messages of two words each out of text that simply has no break in it.
    if (at > budget / 2) return at + boundary.length
  }
  return budget
}
