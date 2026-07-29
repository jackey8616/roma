import type { ChannelAdapter, IngressMessage, OutboundInstruction } from './channel-adapter.js'
import { TurnFailedError } from './claude-session.js'
import { sessionIdFor } from './session-id.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import type { TaskQueue } from './task-queue.js'

export interface CoreOptions {
  /**
   * Where this Core's messages come from and go back to.
   *
   * One Core per Channel, sharing one pool. That is what keeps the Core free of
   * Channel identity: there is no routing table to consult and no field to
   * inspect, because a Core only ever has one place to reply to. (Two Channels
   * that mint the same Conversation Key would share a Session — ADR-0003 leaves
   * whether that is allowed undecided, and nothing here depends on it.)
   */
  readonly channel: ChannelAdapter
  readonly pool: SessionPool
  /**
   * Shared with every other Core, exactly as the pool is.
   *
   * Required rather than defaulted, because a queue each Core made for itself
   * would still work and would still be wrong: the cap is three Tasks across
   * the whole of roma, and one queue per Channel silently makes it three per
   * Channel.
   */
  readonly queue: TaskQueue
}

/**
 * roma with the Channel taken out: a message goes in, outbound instructions
 * come out.
 *
 * Everything hard is on the other side of it — Session lifetime, resume,
 * eviction, serialisation, cost — and none of it has any idea which product the
 * message came from. That is the point of the split rather than a side effect of
 * it: a second Channel is an Adapter, not a rewrite, and the only thing keeping
 * that true is that nothing in here can name one.
 *
 * A Task ends one of two ways, and both of them are something the Conversation
 * is told: the result of the Turn, or why there isn't one. Silence is not an
 * outcome the Core has — someone waiting on a Task that died is the failure this
 * exists to prevent.
 */
export class Core {
  readonly #channel: ChannelAdapter
  readonly #pool: SessionPool
  readonly #queue: TaskQueue

  constructor({ channel, pool, queue }: CoreOptions) {
    if (!channel.capabilities.stableConversationKey) {
      // No Adapter should ever declare this false: a Channel without a stable key
      // of its own mints and persists one inside its Adapter, so the key is
      // stable by the time the Core sees it. Which is exactly why the
      // declaration is worth reading — the Core derives ids and stores nothing,
      // so it has nowhere to make an unstable key stable, and an Adapter that
      // says it cannot supply one is describing a bug. Better as a refusal here
      // than as Conversations that quietly forget everything they were told.
      throw new Error('a Channel must supply a stable Conversation Key')
    }
    this.#channel = channel
    this.#pool = pool
    this.#queue = queue
  }

  /**
   * Run one Task: the message in, the Turn it drives, the outcome back out.
   *
   * The Task waits its turn first. Its Session may already be busy — two
   * messages in one Conversation are handled one at a time, because two
   * processes writing one Session file corrupt it — or roma may already be
   * running as much as it runs at once. Either way the Conversation is told it
   * is waiting rather than left with silence.
   *
   * Resolves when the Conversation has been told how it went. It rejects only
   * if the Channel could not be told at all — a failed Task is an outcome, not
   * an error, and reporting it is how this method succeeds.
   */
  async runTask(message: IngressMessage): Promise<void> {
    const { conversationKey } = message
    // No lookup, no record, nothing to have gone stale: the Conversation Key is
    // the Session id, one hash apart.
    const sessionId = sessionIdFor(conversationKey)

    let instruction: OutboundInstruction
    try {
      const turn = await this.#queue.run(
        sessionId,
        () => this.#pool.send(sessionId, message.text),
        // A notice that could not be delivered abandons the Task, which is then
        // reported as one that failed. Someone who believes their message was
        // never received is the state this notice exists to prevent, and
        // running anyway leaves them watching for a reply to something they are
        // about to send again — so "roma could not run this Task" is both the
        // truth and the more useful of the two answers.
        (position) => this.#channel.deliver({ kind: 'queued', conversationKey, position }),
      )
      instruction = { kind: 'result', conversationKey, text: turn.text }
    } catch (error) {
      instruction = { kind: 'failure', conversationKey, reason: reasonFor(error) }
    }

    await this.#channel.deliver(instruction)
  }
}

/**
 * What roma says about a Task that failed on roma's side rather than in the Turn.
 *
 * Deliberately plain and deliberately fixed. The alternative is forwarding the
 * error's own message, and those are written for whoever is reading the code:
 * "claude exited mid-Turn (code=1, signal=null)", or a Session uuid the person
 * in the Conversation has never seen and cannot act on. What a Conversation
 * needs from this is that the Task is dead, so that nobody waits on it. The
 * detail is an operator's, and the pool already writes the process's side of it
 * — an `exit` record with the code and the signal — where operators look.
 */
const ROMA_FAILED = 'roma could not run this Task.'

/**
 * What to tell the Conversation about a Task that produced no result.
 *
 * A failed Turn usually explains itself in its own text — "Failed to
 * authenticate. API Error: 401 API key is invalid." is Claude Code's sentence,
 * not ours, and it is more use than anything the Core could write about it.
 */
function reasonFor(error: unknown): string {
  if (error instanceof RetryStormError) return retryStormReason(error)
  if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
  return ROMA_FAILED
}

/**
 * What to say about a Task roma stopped waiting on.
 *
 * Named rather than folded into `ROMA_FAILED`, because this is the one failure
 * where roma made the decision and the person can act on it. A 401 here is a
 * credential someone has to go and fix; a 529 is worth sending again in a
 * minute. Neither is deducible from "roma could not run this Task."
 *
 * The status comes from the retry events themselves. The error proper never
 * arrives — it surfaces only once the retries are exhausted, which is precisely
 * the wait that was cut short.
 */
function retryStormReason({ retries, lastRetry }: RetryStormError): string {
  const cause = [lastRetry.errorStatus, lastRetry.error].filter((part) => part !== null).join(' ')
  const gaveUp = `roma gave up after ${retries} API ${retries === 1 ? 'retry' : 'retries'}`
  return cause === '' ? `${gaveUp}.` : `${gaveUp} (${cause}).`
}
