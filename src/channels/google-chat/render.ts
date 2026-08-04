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
 * The Caller is mentioned on the **first** message only, and inside the text
 * rather than added to it afterwards: `split` cuts at Chat's 4096-character
 * limit, so a mention bolted on after the split would push the first message
 * over it and Chat would refuse the whole answer. Only the first, because each
 * of these is a separate post and a long answer should not notify somebody once
 * per 4096 characters of it.
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

/**
 * What a blocked Task's message says.
 *
 * The time comes from the event's own `resetsAt`, never an estimate. That the
 * Task is kept is said too: told only that quota is spent, people send the
 * message again — the resend the acknowledgement design exists to prevent.
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
export function progressText(caller: string, progress: TaskProgress): string {
  const to = addressedTo(caller)
  return to + fitted(phrase(progress), MAX_TEXT - to.length)
}

/**
 * One acknowledgement phrase, inside what the mention leaves of Chat's limit.
 *
 * **Nothing reaches this any more.** Every phase is bounded where it is written
 * — four of them are a fixed sentence around a small number, and the fifth is
 * cut to `MAX_TOOL_CHARS` — so the longest phrase this can be handed is around
 * 129 characters against a budget of roughly 4077. It is kept anyway, and the
 * reason is the sixth phase rather than any of the five: `tool` was added
 * without anybody thinking about its length, and this file went a release
 * carrying a phrase Chat could refuse outright (#75). A guard that sits on the
 * finished string is the one the next phase cannot forget to ask for.
 *
 * Which is why it is exported and tested directly. Reached through
 * `progressText` it cannot be made to fire, so a test that drives a long tool
 * through the Adapter is testing `MAX_TOOL_CHARS` and would stay green if this
 * function were deleted.
 *
 * Over the limit is not a longer message but no message: Chat refuses the whole
 * thing rather than trimming it. The **end** is what goes, for the reason the
 * `tool` phase gives below.
 *
 * The budget is passed in rather than read off `MAX_TEXT` for the reason `split`
 * gives below — the mention is already spent out of the limit.
 *
 * What it promises is exactly `result.length <= budget`, for every budget. Which
 * is worth stating because the obvious implementation does not: an ellipsis
 * costs a character, so a budget of nothing answered with `…` is one character
 * over the one thing this function is for. It cannot make the *message* fit
 * when the mention alone has spent the limit — nothing here can, and that is the
 * mention's problem — but it can decline to add to it.
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

/**
 * How much of a tool's command the acknowledgement quotes.
 *
 * A judgement, not a measurement — unlike the throttle's 2641ms and `MAX_TEXT`,
 * which is Chat's own. Behind it are two recorded `task_started` descriptions at
 * 8 and 56 characters, which says the ordinary case is never cut and nothing
 * about the tail.
 *
 * Counts the command alone, where `fitted` spends its ellipsis out of the
 * budget: that budget is somebody else's hard limit where one character over is
 * a refused message, and this one is roma's own reading limit.
 */
const MAX_TOOL_CHARS = 120

/**
 * The acknowledgement without its mention.
 *
 * Every phrase is a fixed sentence around a small number, except the tool's,
 * which is named by Claude Code's own description of it and is bounded here.
 * `fitted` bounds whatever this returns a second time, and by a different
 * measure — see there for why that is not the same guard twice.
 */
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
      // asked for this. Nothing about how far along it is: the figures arrive
      // with the boundary, which is the moment it is finished.
      return 'Compacting…'
    case 'thinking':
      return `Thinking… (~${progress.estimatedTokens} tokens)`
    case 'tool':
      // The one thing that keeps a tool window from reading as a hang: the
      // stream says nothing at all until the tool finishes, 25 seconds in the
      // capture this was designed against.
      //
      // Cut mid-character rather than at a word boundary, against the example
      // `split` sets below: a command cut at a space reads as a whole command,
      // and `Running rm -rf…` is a worse thing to put in front of somebody at a
      // glance than the visibly severed `Running rm -rf /home/user/proj…`.
      // `split` trims prose, where a clean edge is the point; this quotes a
      // command, where a clean edge is the lie.
      //
      // The sentence's own `…` carries both meanings at once — the tool is
      // still running, and the command goes on past here. There is no second
      // marker deliberately: a reader who learned how much was cut would do
      // nothing differently with it, and this message is read at a glance.
      return `Running ${progress.tool.slice(0, MAX_TOOL_CHARS)}…`
    case 'writing':
      // Deliberately not the prose. Shown here it would say what the Result is
      // about to say, seconds later and one message further down — the
      // duplicate ADR-0010 is about. What is left is the one thing this message
      // is for: a number that keeps moving, so a Turn that is writing does not
      // read as a Turn that has died.
      return `Writing… (${progress.characters} chars)`
  }
}

function commandText(command: Command, carriedOut: boolean): string {
  if (command === 'clear') return 'Started a fresh session. Nothing from before this is in it.'
  // Two messages for one `/stop`, and both earn their place: this one answers
  // the person who typed it, and the Task's own "Stopped." lands on the
  // acknowledgement they had been watching.
  return carriedOut ? 'Stopping…' : 'Nothing to stop.'
}

/**
 * One answer as the messages Chat will accept.
 *
 * Broken at a blank line, then a line ending, then a space: cutting mid-word
 * makes a long answer read as corrupted rather than as continued.
 *
 * The prefix is counted against the limit, never added after it, so mentioning
 * the Caller cannot be what makes Chat refuse an answer that would have fitted.
 */
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
    // Not right at the start: a boundary in the first few characters would make
    // messages of two words each out of text that simply has no break in it.
    if (at > MAX_TEXT / 2) return at + boundary.length
  }
  return MAX_TEXT
}
