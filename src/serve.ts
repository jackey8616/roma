import type { ChannelAdapter, IngressMessage } from './channel-adapter.js'
import type { Core, CoreLogRecord } from './core.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { PoolLogRecord } from './session-pool.js'
import type { ShimLogRecord } from './shim-server.js'
import type { SelfCheckLogRecord } from './startup-self-check.js'
import { startRoma, type ReachLogRecord, type Roma, type StartRomaOptions } from './startup.js'
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
       * cost is invisible: the Turn may well have run and spent quota, and a
       * Transport with somewhere to hand it back to will run it again. Where
       * there is nowhere, this line is the only trace the Task leaves anywhere
       * (ADR-0028).
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
export type ServeLog = OperatorLog<
  | PoolLogRecord
  | CoreLogRecord
  | IngressLogRecord
  | ShimLogRecord
  | ReachLogRecord
  | SelfCheckLogRecord
>

/**
 * One Channel roma answers on, and the Transport its events arrive over, paired
 * and then erased.
 *
 * Opaque, and `bind` is the only way to make one — which is the whole of the
 * design rather than a detail of it. What this hides is the type of event that
 * Channel delivers: `serve` holds a list of these and can name no type variable
 * per element, so the pairing is checked once, at the boundary that makes one,
 * and nothing after it has to be able to state it (ADR-0028).
 */
export interface ChannelBinding {
  /**
   * Give this Channel a Core of its own, out of what every Channel shares.
   *
   * The Core is built here rather than handed in so that it is built over *this*
   * binding's Adapter and cannot be built over another's. `build` is everything
   * a Core is made of except the Channel — see `StartRomaOptions.channels` for
   * why every one of those is roma-wide.
   */
  coreOver(build: (channel: ChannelAdapter) => Core): BoundChannel
}

/** One Channel's Core, and the Transport that has not started delivering yet. */
export interface BoundChannel {
  readonly core: Core
  /**
   * Start delivering this Channel's events into that Core.
   *
   * Resolves once roma has subscribed, and hands back the two things shutting
   * down needs.
   */
  receive(log: ServeLog): Promise<Receiving>
}

/** One Channel, subscribed, and the two things ending it takes. */
export interface Receiving {
  /** Hand every Delivery back from here rather than finish with it. */
  stop(): void
  close(): Promise<void>
}

/**
 * Pair one Channel with the Transport its events arrive over.
 *
 * **The one thing assembling roma can get wrong that nothing else would
 * notice.** A Transport delivering events this Adapter cannot read produces a
 * roma that runs perfectly and ignores everything it is sent. Neither `Core` nor
 * `Transport` can see that on its own — this is where the two meet, and one type
 * variable across both parameters is the whole of the check.
 *
 * A function rather than a field on `ServeOptions`, because roma serves several
 * Channels and a list cannot carry a type variable per element: a `readonly
 * { channel: ChannelAdapter<any>; transport: Transport<any> }[]` type-checks and
 * pairs nothing. So the pair is made where it can be stated and `Event` is gone
 * by the time `serve` holds it (ADR-0028).
 *
 * Both passed in rather than built here. What it takes to reach a Channel or a
 * queue — a project, a subscription name, a credential — is the deployment's
 * business, and roma reads what already exists rather than provisioning any of
 * it.
 */
export function bind<Event>(
  channel: ChannelAdapter<Event>,
  transport: Transport<Event>,
): ChannelBinding {
  return {
    coreOver: (build) => {
      const core = build(channel)
      return {
        core,
        receive: async (log) => {
          const ingress = new Ingress<Event>({ core, channel, log })
          await transport.receive((delivery) => ingress.take(delivery))
          return { stop: () => ingress.stop(), close: () => transport.close() }
        },
      }
    },
  }
}

/**
 * Everything `startRoma` takes, with a log wide enough for the subscriber too.
 *
 * The only member of its own, because the only thing `serve` adds to `startRoma`
 * is the ingress: what roma is assembled out of is already `StartRomaOptions`,
 * and restating any of it here would be a second place to keep it true.
 */
export interface ServeOptions extends Omit<StartRomaOptions, 'log'> {
  readonly log?: ServeLog
}

/** roma, running and listening. */
export interface Serving extends Roma {
  /**
   * Stop taking messages on every Channel, then end every Resident Session.
   *
   * In that order, and the order is the point: a roma that killed its processes
   * while still subscribed would accept a message it had nothing left to serve
   * it with. Sessions survive this — their context is on disk.
   *
   * It does not wait for the Tasks already running. They are killed with the
   * processes, and their Deliveries are handed back rather than finished with.
   * That is a deliberate choice between two imperfect endings: waiting would
   * make a SIGTERM take however long the slowest Turn takes, and finishing with
   * them would tell somebody their Task failed and then lose it.
   *
   * **What handing back buys depends on the Transport.** One with somewhere to
   * hand a Delivery back to delivers it again to whatever comes up next; one
   * without loses the work and says nothing to the Conversation, which ADR-0028
   * accepts and #171 is about. The consequence on the other side is worth
   * knowing too: where a Delivery is redelivered, a Task that finished in the
   * moment between the shutdown starting and its answer being posted is answered
   * *and* run again.
   */
  shutdown(): Promise<void>
}

/**
 * Start roma and put every Channel on its Transport: the whole program,
 * assembled.
 *
 * Two steps, and the second cannot happen without the first. `startRoma` proves
 * the credential and builds the Cores; only then is anything subscribed. That is
 * the acceptance criterion "the process begins accepting messages only after the
 * startup self-check passes" made structural rather than remembered — a boot
 * that fails the check throws from here with nothing subscribed, so there is no
 * window in which a message can arrive at a roma that has not proved what it
 * runs on.
 */
export async function serve(options: ServeOptions): Promise<Serving> {
  const { log = writeToStderr, ...startOptions } = options
  const roma = await startRoma({ ...startOptions, log })

  const receiving: Receiving[] = []
  try {
    for (const channel of roma.channels) receiving.push(await channel.receive(log))
  } catch (error) {
    // Subscribing failed with roma already built. Ending it here rather than
    // leaving it: nothing can reach a pool nothing is subscribed to, and its
    // processes would outlive the boot that failed. Whatever had already
    // subscribed goes with it — a Channel left delivering into a roma that is
    // not there is the same fault by a longer route.
    await Promise.allSettled(receiving.map((channel) => channel.close()))
    await roma.shutdown()
    throw error
  }

  return {
    ...roma,
    shutdown: async () => {
      // Before any Transport is closed, not after: from here on every Delivery
      // roma is holding is one it is about to kill the Task for, and settling
      // one as done would throw that work away. Every Channel before any close
      // rather than each in turn, because closing takes as long as it takes and
      // the other Channels' Tasks are settling throughout it.
      for (const channel of receiving) channel.stop()
      const closed = await Promise.allSettled(receiving.map((channel) => channel.close()))
      // Whatever any of them did, and once rather than once per Channel. A
      // `close` that rejected and took the pool down with it would leave
      // `claude` processes running with nothing to talk to, which is the one
      // thing shutdown exists to prevent.
      await roma.shutdown()
      for (const closing of closed) {
        if (closing.status === 'rejected') throw closing.reason
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
 * The one decision neither side can make: whether the queue is finished with
 * this message. Three answers, split on whether trying again could ever help.
 *
 * - **Answered**, badly or well. Acknowledge.
 * - **Not for roma, or unreadable.** Acknowledge, or it is redelivered for as
 *   long as the subscription keeps it.
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
   * Two questions of every event: the second is somebody answering an offer
   * about a Task roma already holds, and routing it as an ingress message would
   * be a second piece of work in a Conversation waiting on the first.
   *
   * Hands the work back rather than doing it, so the two failures stay apart:
   * an Adapter that throws was handed something no redelivery will fix, where a
   * Core that rejects failed to reach the Channel and might not next time.
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
