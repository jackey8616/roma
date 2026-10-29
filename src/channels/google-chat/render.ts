import type { OutboundInstruction, TaskProgress } from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
import { progressPhrase } from '../../progress-phrase.js'

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
 * How Chat says "this message is for you", and the space that separates it from
 * what follows.
 *
 * `caller` is already a Chat user resource name, so the mention is the identity
 * in angle brackets and nothing else — no Conversation Key involved.
 * https://developers.google.com/workspace/chat/identify-reference-users
 *
 * A DM gets one too, though the Adapter could tell from the Conversation Key: a
 * rule with an exception in it is a rule somebody has to remember.
 */
function addressedTo(caller: string): string {
  return `<${caller}> `
}

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
 *
 * The Caller is mentioned on the **first** message only, inside the limit.
 * Enforced by `fence:gchat-split-under-the-limit`.
 * Enforced by `fence:gchat-mention-once-per-answer`.
 */
export function outcomeMessages(instruction: TaskOutcome): string[] {
  const to = addressedTo(instruction.caller)
  switch (instruction.kind) {
    case 'result': {
      // Its own message or messages, never the acknowledgement edited one last
      // time — the rule ADR-0003 makes unconditional, because the result is what
      // people search for and quote months later.
      const messages = split(to, instruction.text)
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
      return split(to, instruction.reason)
    case 'choice':
      // Only the text. The buttons are the Adapter's, because they are a Chat
      // card rather than words — and the text already names the Menu, so a
      // message that lost them would still be the whole answer (ADR-0023).
      return split(to, instruction.text)
    case 'stopped':
      return [`${to}Stopped.`]
    case 'command-outcome':
      return [to + commandText(instruction.command, instruction.carriedOut)]
    case 'blocked':
      return [to + blockedText(instruction.resetsAt)]
    case 'context-full':
      // Said as the consequence rather than as the cause, because roma has two
      // codes that arrive here and they have different causes — a context that
      // will not shrink, and attached media that cannot be stripped out of one.
      // "This thread is too long" would be false for the second and the person
      // would act on it anyway.
      //
      // Names the Command, because the remedy is the point of the message: a
      // sentence that only said the Session was finished would leave somebody
      // stuck with the same fact and nothing to do about it. What it costs is
      // said too — `/clear` discards, and somebody who found that out afterwards
      // would have been right to expect a warning.
      return [
        `${to}Claude cannot shorten this conversation any further, so it cannot take ` +
          `another message. Send /clear to start a fresh session — nothing from this one ` +
          `carries over.`,
      ]
    case 'overflow-refused':
      // What they can still do is the point of the sentence: the Task is not
      // over, and telling them only that they were refused would read as one
      // that is.
      return [
        `${to}Overflow is capped at $${money(instruction.capUsd)} a month and this month has ` +
          `spent $${money(instruction.spentUsd)}, so it is off until the month turns. ` +
          `Your task is still waiting for the shared quota to reset.`,
      ]
  }
}

/** Enforced by `fence:gchat-blocked-says-the-task-is-kept`. */
function blockedText(resetsAt: number): string {
  const at = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return `The shared Claude quota is spent. It comes back at ${at} UTC — I have kept your task and will run it then.`
}

/** What an Overflow Turn spent, to the cent it was billed in. */
function overflowSpentText(costUsd: number | null): string {
  // Enforced by `fence:gchat-unpriced-is-not-free`.
  if (costUsd === null) return 'Ran on metered billing. What it cost was never reported.'
  return `Ran on metered billing: $${money(costUsd)}.`
}

/** Money as people read it, which is two decimal places and no more. */
function money(usd: number): string {
  return usd.toFixed(2)
}

/**
 * The acknowledgement's text for one phase, addressed and fitted to Chat.
 *
 * The words are `progressPhrase`'s, which is where they are argued. What is
 * Chat's is the mention in front of them and the limit they have to fit inside
 * once it has been spent.
 */
export function progressText(caller: string, progress: TaskProgress): string {
  const to = addressedTo(caller)
  return to + fitted(progressPhrase(progress), MAX_TEXT - to.length)
}

/**
 * One acknowledgement phrase, inside what the mention leaves of Chat's limit.
 *
 * The **end** is what goes, for the reason `progressPhrase` gives about the tool
 * it quotes. The budget is what the mention leaves of `MAX_TEXT`.
 *
 * What it promises is exactly `result.length <= budget`, for every budget. It
 * cannot make the *message* fit when the mention alone has spent the limit, but
 * it can decline to add to it. Enforced by `fence:gchat-fitted-holds-the-budget`.
 */
export function fitted(text: string, budget: number): string {
  if (text.length <= budget) return text
  // A budget that cannot even hold the ellipsis is answered with nothing rather
  // than with the ellipsis, so that the promise above holds at both ends.
  if (budget < 1) return ''
  // Clamped because a negative length reads from the *end* in JavaScript, which
  // is the one input that would turn this from a trim into its own opposite.
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

function commandText(command: Command, carriedOut: boolean): string {
  if (command === 'clear') return 'Started a fresh session. Nothing from before this is in it.'
  // Two messages for one `/stop`, and both earn their place: this one answers
  // the person who typed it, and the Task's own "Stopped." lands on the
  // acknowledgement they had been watching.
  return carriedOut ? 'Stopping…' : 'Nothing to stop.'
}

/** Enforced by `fence:gchat-split-under-the-limit`. */
function split(prefix: string, text: string): string[] {
  // A Turn can finish having written nothing. Posting nothing at all would make
  // it indistinguishable from a Task that died — and it is still somebody's
  // Task, so it is still addressed to them.
  if (text.trim() === '') return [`${prefix}(roma finished without saying anything.)`]

  const messages: string[] = []
  let rest = prefix + text
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
    // Enforced by `fence:gchat-split-at-a-late-boundary`.
    if (at > MAX_TEXT / 2) return at + boundary.length
  }
  return MAX_TEXT
}
