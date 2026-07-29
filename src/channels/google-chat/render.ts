import type { OutboundInstruction, TaskProgress } from '../../channel-adapter.js'
import type { Command } from '../../commands.js'

/**
 * Chat's limit on the text of one message.
 *
 * Not advisory: the API rejects a longer one, so a Turn that wrote more than
 * this has to arrive as several messages or not at all. The generating capture
 * in `test/fixtures/claude-stream/` is 17706 characters, so this is the ordinary
 * case rather than an edge.
 */
export const MAX_TEXT = 4096

/**
 * What the button that takes Overflow says.
 *
 * It says that it costs money, because that is the whole of the decision being
 * asked for: ADR-0002 has the valve off by default precisely so that spending is
 * something somebody chooses, and a button labelled "Run anyway" would be that
 * choice made by somebody who did not know they were making it.
 */
export const OVERFLOW_BUTTON = 'Run it on metered billing'

/**
 * Everything the Core can say about a Task except that it is still going.
 *
 * Its own type because the two are answered differently in Chat — an outcome is
 * a new message and progress edits one that exists — and because an outcome can
 * be several messages while progress is always exactly one.
 */
type NotProgress<T> = T extends { readonly kind: 'progress' } ? never : T
export type TaskOutcome = NotProgress<OutboundInstruction>

/**
 * How a Task's outcome reads in Chat.
 *
 * Wording is the Channel's business: the Core hands over facts — stopped,
 * nothing to stop, this text — because it cannot see the result of any sentence
 * it might write. The exception is a failure, whose reason the Core does write
 * and this passes through, since it is one sentence that reads the same on every
 * Channel and a second voice on the same fact would only muddle it.
 *
 * One message per string, in the order they should be posted. More than one when
 * what has to be said is longer than Chat will take.
 */
export function outcomeMessages(instruction: TaskOutcome): string[] {
  switch (instruction.kind) {
    case 'result': {
      // Its own message or messages, never the acknowledgement edited one last
      // time — the rule ADR-0003 makes unconditional, because the result is what
      // people search for and quote months later.
      const messages = split(instruction.text)
      // ADR-0002 requires the spend shown in the reply, and only where somebody
      // chose to spend it. Its own message rather than appended to the answer:
      // the answer is what gets quoted later, and a price tag inside it would be
      // quoted along with it.
      if (instruction.overflowCostUsd !== undefined) {
        messages.push(overflowSpentText(instruction.overflowCostUsd))
      }
      return messages
    }
    case 'failure':
      // Split like a result, because it is one: a failed Turn's reason is the
      // Turn's own text, and that has no more of a length limit than an answer
      // does. Posted whole, Chat would refuse it and the Conversation would be
      // told nothing at all about a Task that is already dead.
      return split(instruction.reason)
    case 'stopped':
      return ['Stopped.']
    case 'command-outcome':
      return [commandText(instruction.command, instruction.carriedOut)]
    case 'blocked':
      return [blockedText(instruction.resetsAt)]
    case 'overflow-refused':
      // What they can still do is the point of the sentence: the Task is not
      // over, and telling them only that they were refused would read as one
      // that is.
      return [
        `Overflow is capped at $${money(instruction.capUsd)} a month and this month has ` +
          `spent $${money(instruction.spentUsd)}, so it is off until the month turns. ` +
          `Your task is still waiting for the shared quota to reset.`,
      ]
  }
}

/**
 * What a blocked Task's message says.
 *
 * Plainly that quota is spent, and when it comes back — from the event's own
 * `resetsAt` rather than an estimate, which is the only reason a time is worth
 * quoting. That the Task is kept is said too: told only that quota is spent,
 * people send the message again, which is the behaviour the whole
 * acknowledgement design exists to prevent.
 */
function blockedText(resetsAt: number): string {
  const at = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return `The shared Claude quota is spent. It comes back at ${at} UTC — I have kept your task and will run it then.`
}

/** What an Overflow Turn spent, to the cent it was billed in. */
function overflowSpentText(costUsd: number | null): string {
  // Null is a Turn nothing priced, and saying "$0.00" would report money as free
  // — the same claim the Audit Record refuses to make.
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
  switch (progress.phase) {
    case 'queued':
      // The count includes this Task, so 1 means nothing is ahead of it. Said as
      // a number of waiting Tasks rather than as a position, because a Task
      // whose Session is busy is stepped over: this is the size of the backlog,
      // not a place in a running order.
      return progress.position === 1 ? 'Queued.' : `Queued — ${progress.position} waiting.`
    case 'working':
      return 'Working…'
    case 'thinking':
      return `Thinking… (~${progress.estimatedTokens} tokens)`
    case 'tool':
      // The one thing that keeps a tool window from reading as a hang: the
      // stream says nothing at all until the tool finishes, 25 seconds in the
      // capture this was designed against.
      return `Running ${progress.tool}…`
    case 'writing':
      return tail(progress.text)
  }
}

function commandText(command: Command, carriedOut: boolean): string {
  if (command === 'new') return 'Started a fresh session. Nothing from before this is in it.'
  // Two messages for one `/stop`, and both earn their place: this one answers
  // the person who typed it, and the Task's own "Stopped." lands on the
  // acknowledgement they had been watching.
  return carriedOut ? 'Stopping…' : 'Nothing to stop.'
}

/**
 * The end of a partial answer, cut to fit.
 *
 * The end rather than the beginning, because this is the message that says the
 * Task is alive. Frozen at the first 4096 characters it would stop moving
 * halfway through a long answer, which is exactly what a dead Task looks like.
 */
function tail(text: string): string {
  if (text.length <= MAX_TEXT) return text
  return `…${text.slice(-(MAX_TEXT - 1))}`
}

/**
 * One answer as the messages Chat will accept.
 *
 * Broken at a blank line where there is one, then at a line ending, then at a
 * space — a paragraph boundary is where a reader would have broken it too, and
 * cutting mid-word makes a long answer read as corrupted rather than as
 * continued.
 */
function split(text: string): string[] {
  // A Turn can finish having written nothing. Posting nothing at all would make
  // it indistinguishable from a Task that died.
  if (text.trim() === '') return ['(roma finished without saying anything.)']

  const messages: string[] = []
  let rest = text
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT)
    const at = breakPoint(window)
    messages.push(window.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest !== '') messages.push(rest)
  return messages
}

/** Where to cut a full window: the last paragraph, line, or word boundary in it. */
function breakPoint(window: string): number {
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(boundary)
    // Not right at the start: a boundary in the first few characters would make
    // messages of two words each out of text that simply has no break in it.
    if (at > MAX_TEXT / 2) return at + boundary.length
  }
  return MAX_TEXT
}
