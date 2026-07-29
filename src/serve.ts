import type { ChannelAdapter, IngressMessage } from './channel-adapter.js'
import type { Core, CoreLogRecord } from './core.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { PoolLogRecord } from './session-pool.js'
import { startRoma, type Roma, type StartRomaOptions } from './startup.js'
import type { Delivery, Settle, Transport } from './transport.js'

/**
 * One thing the ingress subscriber did that an operator, rather than a
 * Conversation, needs.
 *
 * Every one of these is about an event nobody will be told about anywhere else.
 * An ingress message that reaches the Core produces its own answer in the
 * Conversation and its own Audit Record; these four are the endings that produce
 * neither, which makes this log the only place they exist.
 */
export type IngressLogRecord =
  | {
      /**
       * An event the Channel Adapter could not read.
       *
       * The Channel's shape has changed, or something else is publishing to the
       * subscription. Worth an operator's attention because roma will keep
       * dropping these silently otherwise — there is no Conversation to tell,
       * since working out which Conversation it was is the very thing that
       * failed.
       */
      readonly event: 'ingress-unreadable'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      /**
       * An event roma is not meant to answer. Every Channel has some — another
       * app talking, roma being added somewhere, a gesture aimed at nothing —
       * and which ones they are is that Channel Adapter's business.
       *
       * Routine, and logged anyway. It is the difference between "roma is
       * ignoring these" and "roma is not receiving anything", which are
       * indistinguishable from the outside and have completely different causes.
       */
      readonly event: 'ingress-ignored'
      readonly deliveryId: string
    }
  | {
      /** The same delivery arriving while roma is still doing it. See `#take`. */
      readonly event: 'ingress-redelivered'
      readonly deliveryId: string
    }
  | {
      /**
       * roma could not tell the Conversation anything at all, so the delivery
       * was handed back.
       *
       * The one ingress failure that is worth another attempt, and the one whose
       * cost is invisible: the Turn may well have run and spent quota, and the
       * redelivery will run it again.
       */
      readonly event: 'ingress-failed'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      /**
       * Settling the delivery itself failed — the queue refused the
       * settlement, or roma had already lost its lease on the message.
       *
       * Its own record because the consequence differs from every other failure
       * here: the work happened, the Conversation was answered, and the message
       * is still going to be delivered again.
       */
      readonly event: 'ingress-unsettled'
      readonly deliveryId: string
      readonly settle: Settle
      readonly reason: string
    }

/** Everything the Channel-independent half of roma writes to the operator log. */
export type ServeLog = OperatorLog<PoolLogRecord | CoreLogRecord | IngressLogRecord>

export interface ServeOptions<Event> extends Omit<StartRomaOptions, 'log' | 'channel'> {
  /**
   * The Channel roma answers on, and the Transport its events arrive over.
   *
   * Named by one type variable, because the pairing is the one thing assembling
   * roma can get wrong in a way nothing else would notice: a Transport
   * delivering events this Adapter cannot read produces a roma that runs
   * perfectly and ignores everything it is sent. Neither `Core` nor `Transport`
   * can see that on its own — this is where the two meet.
   *
   * Both passed in rather than built here. What it takes to reach a Channel or a
   * queue — a project, a subscription name, a credential — is the deployment's
   * business, and roma reads what already exists rather than provisioning any of
   * it.
   */
  readonly channel: ChannelAdapter<Event>
  readonly transport: Transport<Event>
  readonly log?: ServeLog
}

/** roma, running and listening. */
export interface Serving extends Roma {
  /**
   * Stop taking messages, then end every Resident Session.
   *
   * In that order, and the order is the point: a roma that killed its processes
   * while still subscribed would accept a message it had nothing left to serve
   * it with. Sessions survive this — their context is on disk.
   *
   * It does not wait for the Tasks already running. They are killed with the
   * processes, and their Deliveries are handed back rather than finished with,
   * so the queue delivers them again to whatever comes up next. That is a
   * deliberate choice between two imperfect endings: waiting would make a
   * SIGTERM take however long the slowest Turn takes, and finishing with them
   * would tell somebody their Task failed and then lose it.
   *
   * The consequence worth knowing: a Task that finished in the moment between
   * the shutdown starting and its answer being posted is answered *and* run
   * again. Handing the Delivery back is what makes that possible, and it is the
   * safer half of the trade — the other half loses work.
   */
  shutdown(): Promise<void>
}

/**
 * Start roma and put it on the queue: the whole program, assembled.
 *
 * Two steps, and the second cannot happen without the first. `startRoma` proves
 * the credential and builds the Core; only then is anything subscribed. That is
 * the acceptance criterion "the process begins accepting messages only after the
 * startup self-check passes" made structural rather than remembered — a boot
 * that fails the check throws from here with nothing subscribed, so there is no
 * window in which a message can arrive at a roma that has not proved what it
 * runs on.
 */
export async function serve<Event>(options: ServeOptions<Event>): Promise<Serving> {
  const { transport, channel, log = writeToStderr, ...startOptions } = options
  const roma = await startRoma({ ...startOptions, channel, log })

  const ingress = new Ingress<Event>({ core: roma.core, channel, log })
  try {
    await transport.receive((delivery) => ingress.take(delivery))
  } catch (error) {
    // Subscribing failed with roma already built. Ending it here rather than
    // leaving it: nothing can reach a pool nothing is subscribed to, and its
    // processes would outlive the boot that failed.
    await roma.shutdown()
    throw error
  }

  return {
    ...roma,
    shutdown: async () => {
      // Before the queue is closed, not after: from here on every Delivery
      // roma is holding is one it is about to kill the Task for, and settling
      // one as done would throw that work away.
      ingress.stop()
      try {
        await transport.close()
      } finally {
        // Whatever the queue did. A `close` that rejected and took the pool
        // down with it would leave `claude` processes running with nothing to
        // talk to, which is the one thing shutdown exists to prevent.
        await roma.shutdown()
      }
    },
  }
}

interface IngressOptions<Event> {
  readonly core: Core
  readonly channel: ChannelAdapter<Event>
  readonly log: ServeLog
}

/**
 * The subscriber's half of the wiring: one event in, one settled delivery out.
 *
 * Everything hard is on either side of it — the Adapter reads the event, the
 * Core runs the work — and what is left here is the decision neither of them can
 * make: whether the queue is finished with this message. Three answers, and the
 * difference between them is whether trying again could ever help.
 *
 * - **Answered.** The Conversation was told how it went, including that it went
 *   badly. Acknowledge.
 * - **Not for roma, or unreadable.** Nothing to do, now or on any later attempt.
 *   Acknowledge, or the same event is redelivered for as long as the
 *   subscription keeps it.
 * - **Nobody was told.** The Channel was unreachable. Hand it back.
 */
class Ingress<Event> {
  readonly #core: Core
  readonly #channel: ChannelAdapter<Event>
  readonly #log: ServeLog
  /**
   * Whether roma is on its way down.
   *
   * Once it is, nothing is finished with. Every Delivery still in flight belongs
   * to a Task whose process is about to be killed, and the failure that produces
   * is not an answer — it is roma stopping, which is not the person's problem to
   * be told about and not a reason to lose what they asked for.
   */
  #stopping = false
  /**
   * The deliveries roma is in the middle of.
   *
   * Held only while the work runs. A queue that delivers at least once will hand
   * the same event over again — after a lease expires, after a settlement is
   * lost — and roma holds a Delivery for as long as its Task takes, which is
   * minutes. Two attempts at one message would spend the Turn twice and post two
   * answers into one Conversation.
   *
   * Deliberately not a record of everything roma has ever seen. That would be a
   * database, which roma does not have and which a restart would empty anyway —
   * and a redelivery arriving after the answer was posted is a message roma
   * genuinely has no memory of, which is the trade at-least-once delivery asks
   * for in exchange for never losing one.
   */
  readonly #inFlight = new Set<string>()

  constructor({ core, channel, log }: IngressOptions<Event>) {
    this.#core = core
    this.#channel = channel
    this.#log = log
  }

  /** roma is going down: hand back everything from here rather than finish it. */
  stop(): void {
    this.#stopping = true
  }

  /**
   * Take one delivery as far as being settled.
   *
   * Never rejects, on any path. A subscriber that fell over on a bad event would
   * make one malformed message the end of roma's ability to answer anybody —
   * which is the whole of why "rejected without stopping the subscriber" is a
   * criterion of its own.
   */
  async take(delivery: Delivery<Event>): Promise<void> {
    const { id } = delivery
    if (this.#inFlight.has(id)) {
      // Left unsettled on purpose. The attempt already doing the work owns the
      // settling, and doing it here would either finish with a Delivery whose
      // Task is still running or hand back one that is about to succeed.
      this.#log({ event: 'ingress-redelivered', deliveryId: id })
      return
    }

    this.#inFlight.add(id)
    try {
      const work = this.#workFor(delivery.event, id)
      if (work !== null) await work
      await this.#settle(delivery, 'ack')
    } catch (error) {
      this.#log({ event: 'ingress-failed', deliveryId: id, reason: reasonOf(error) })
      await this.#settle(delivery, 'nack')
    } finally {
      this.#inFlight.delete(id)
    }
  }

  /**
   * What one event asks roma to do, or null where it asks for nothing.
   *
   * Two questions of every event, because a Channel can deliver two kinds of
   * thing and only one of them is a message. The second is somebody answering an
   * offer roma made about a Task it is already holding — it drives no Turn and
   * starts no Task, so routing it as an ingress message would be a second piece
   * of work in a Conversation that is waiting on the first.
   *
   * Reading the event and running the work are kept apart so that the two
   * failures stay apart — which is why this hands back the work rather than
   * doing it. An Adapter that throws has been handed something it cannot make
   * sense of, and no number of redeliveries will change that; a Core that
   * rejects has failed to reach the Channel, which another attempt might not.
   */
  #workFor(event: Event, deliveryId: string): Promise<unknown> | null {
    let message: IngressMessage | null
    let taskId: string | null = null
    try {
      message = this.#channel.toIngress(event)
      if (message === null) taskId = this.#channel.toOverflowTaken?.(event) ?? null
    } catch (error) {
      this.#log({ event: 'ingress-unreadable', deliveryId, reason: reasonOf(error) })
      return null
    }

    if (message !== null) return this.#core.handle(message)
    if (taskId !== null) return this.#core.takeOverflow(taskId)
    this.#log({ event: 'ingress-ignored', deliveryId })
    return null
  }

  /**
   * Settle one Delivery, and survive the queue refusing to hear it.
   *
   * A settlement that failed is not a failed Task: the work happened and the
   * Conversation was answered. All that follows is a redelivery, which the
   * in-flight check above will not catch because by then roma is no longer doing
   * it — so it is written down here, since a Conversation answered twice is
   * otherwise a mystery with no trace of its cause.
   *
   * Once roma is stopping, every settlement becomes a hand-back regardless of
   * what the work did. What ended those Tasks was roma being killed rather than
   * anything about them, and finishing with their Deliveries would throw away
   * work the queue is otherwise holding for whatever starts next.
   */
  async #settle(delivery: Delivery<Event>, settle: Settle): Promise<void> {
    const settling = this.#stopping ? 'nack' : settle
    try {
      await (settling === 'ack' ? delivery.ack() : delivery.nack())
    } catch (error) {
      this.#log({
        event: 'ingress-unsettled',
        deliveryId: delivery.id,
        settle: settling,
        reason: reasonOf(error),
      })
    }
  }
}
