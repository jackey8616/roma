import type { OutboundInstruction, TaskProgress } from '../../channel-adapter.js'
import type { Command } from '../../commands.js'
import { progressPhrase } from '../../progress-phrase.js'

/**
 * Discord's limit on the text of one message. Not advisory: the API rejects a
 * longer one, so a Turn that wrote more than this arrives as several messages or
 * not at all. Unverified against Discord's own reference (ADR-0029).
 */
export const MAX_TEXT = 2000

/**
 * What the button that takes Overflow says. It says that it costs money, because
 * that is the whole of the decision being asked for: a button labelled "Run
 * anyway" would be that choice made by somebody who did not know they were
 * making it. Enforced by `fence:discord-overflow-worded-as-chat`.
 */
export const OVERFLOW_BUTTON = 'Run it on metered billing'

/** Enforced by `fence:discord-thread-name-fits`. */
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
 * How a Task's outcome reads in Discord: one message per string, in the order
 * they should be posted, more than one when it is longer than Discord will take.
 * A failure's reason is the Core's sentence, passed through.
 *
 * Nothing here addresses the Caller in words: the Adapter replies to the
 * Caller's own message with the first.
 */
export function outcomeMessages(instruction: TaskOutcome): string[] {
  switch (instruction.kind) {
    case 'result': {
      // Enforced by `fence:discord-result-is-its-own-message`.
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
 * What the thread roma opens from a top-level message is called: the Caller's
 * own first line, fitted. A message with no words in it (a pasted screenshot)
 * leaves roma's own name.
 */
export function threadName(text: string): string {
  const [first = ''] = text.trim().split('\n')
  return first.trim() === '' ? 'roma' : fitted(first.trim(), MAX_THREAD_NAME)
}

function blockedText(resetsAt: number): string {
  const at = new Date(resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
  return `The shared Claude quota is spent. It comes back at ${at} UTC — I have kept your task and will run it then.`
}

function overflowSpentText(costUsd: number | null): string {
  // Enforced by `fence:discord-null-cost-not-free`.
  if (costUsd === null) return 'Ran on metered billing. What it cost was never reported.'
  return `Ran on metered billing: $${money(costUsd)}.`
}

function money(usd: number): string {
  return usd.toFixed(2)
}

/**
 * The Acknowledgement's text for one phase: `progressPhrase`'s words, fitted to
 * Discord, addressed to nobody (the Adapter's reply does that).
 */
export function progressText(progress: TaskProgress): string {
  return fitted(progressPhrase(progress), MAX_TEXT)
}

function fitted(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget < 1) return ''
  // Clamped because a negative length reads from the *end* in JavaScript, which
  // is the one input that would turn this from a trim into its own opposite.
  return `${text.slice(0, Math.max(0, budget - 1))}…`
}

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

function breakPoint(window: string, budget: number): number {
  for (const boundary of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(boundary)
    // Enforced by `fence:discord-split-no-tiny-pieces`.
    if (at > budget / 2) return at + boundary.length
  }
  return budget
}
