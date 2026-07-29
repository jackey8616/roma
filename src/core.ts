import { randomUUID } from 'node:crypto'
import type { ChannelAdapter, IngressMessage, OutboundInstruction } from './channel-adapter.js'
import { TurnFailedError, type Turn } from './claude-session.js'
import { ProgressReporter } from './progress-reporter.js'
import { sessionIdFor } from './session-id.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import type { ClaudeEvent } from './stream-events.js'
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
   * The Task is acknowledged before it has produced anything, and that
   * acknowledgement keeps changing while it runs, so nobody is left guessing
   * whether it is alive. It waits its turn first — its Session may already be
   * busy, since two messages in one Conversation are handled one at a time
   * because two processes writing one Session file corrupt it, or roma may
   * already be running as much as it runs at once — and waiting is a thing the
   * acknowledgement says rather than a silence.
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
    // Minted here rather than derived, because it names this Task and not the
    // Conversation: two messages in one Conversation can be in flight at once,
    // each with an acknowledgement of its own for the Adapter to keep up to
    // date.
    const taskId = randomUUID()

    const reporter = new ProgressReporter({
      // The Adapter is told whether it may edit; the Core is what obeys the
      // answer. Where it cannot, the acknowledgement is sent once and nothing
      // follows it.
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) =>
        this.#channel.deliver({ kind: 'progress', taskId, conversationKey, progress }),
    })

    let instruction: OutboundInstruction
    try {
      const turn = await this.#queue.run(
        sessionId,
        () => this.#runTurn(sessionId, message.text, reporter),
        // The one thing roma will go without, and it is the reporter that
        // absorbs the failure: a Channel too broken to carry this is too broken
        // to carry the failure that abandoning the Task would produce, so
        // refusing to run it buys no less silence — it only adds losing the
        // work to it.
        (position) => reporter.update({ phase: 'queued', position }),
      )
      instruction = { kind: 'result', taskId, conversationKey, text: turn.text }
    } catch (error) {
      instruction = { kind: 'failure', taskId, conversationKey, reason: reasonFor(error) }
    }

    // Nothing more is scheduled, and nothing in flight is waited on: an update
    // the Channel has not finished taking is not a reason to hold back the one
    // message roma owes unconditionally.
    reporter.stop()
    await this.#channel.deliver(instruction)
  }

  /**
   * Drive the Turn, reporting on it as the stream says what it is doing.
   *
   * The acknowledgement goes out here rather than on arrival, so that a Task
   * that had to wait says it was waiting first and only then says it is
   * running. Both are the same message; this is the second thing it says.
   *
   * Filtered by Session id because the pool is shared by every Core, so its
   * events are every Conversation's. The listener is a Turn's worth long: one
   * Task, one subscription, dropped in the `finally` whichever way the Turn
   * ended.
   */
  async #runTurn(sessionId: string, text: string, reporter: ProgressReporter): Promise<Turn> {
    reporter.update({ phase: 'working' })
    const onEvent = (id: string, event: ClaudeEvent): void => {
      if (id === sessionId) reporter.observe(event)
    }
    this.#pool.on('event', onEvent)
    try {
      return await this.#pool.send(sessionId, text)
    } finally {
      this.#pool.off('event', onEvent)
    }
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
