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
 * Conversation, needs: endings that produce no answer and no Audit Record, so
 * this log is the only place they exist.
 */
export type IngressLogRecord =
  | {
      /**
       * An event the Channel Adapter could not read: the Channel's shape has
       * changed, or something else is publishing to the subscription. Enforced
       * by `fence:serve-unreadable-is-finished-and-logged`.
       */
      readonly event: 'ingress-unreadable'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      /**
       * An event roma is not meant to answer, as the Channel Adapter decides.
       * Routine, and logged so that "roma is ignoring these" can be told from
       * "roma is receiving nothing".
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
       * was handed back. The Turn may have run and spent quota, and a Transport
       * that redelivers will run it again; one that does not leaves this line
       * as the Task's only trace.
       */
      readonly event: 'ingress-failed'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      /**
       * Settling the delivery itself failed — the queue refused the
       * settlement, or roma had already lost its lease on the message. The
       * Conversation may have been answered and the message will still be
       * delivered again.
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
 * One Channel and the Transport its events arrive over, paired with the event
 * type erased. Opaque: `bind` is the only way to make one.
 */
export interface ChannelBinding {
  /**
   * Give this Channel a Core of its own, out of what every Channel shares.
   * `build` is everything a Core is made of except the Channel, so the Core can
   * only be built over this binding's Adapter.
   */
  coreOver(build: (channel: ChannelAdapter) => Core): BoundChannel
}

/** One Channel's Core, and the Transport that has not started delivering yet. */
export interface BoundChannel {
  readonly core: Core
  /** Start delivering this Channel's events into that Core. Resolves once roma has subscribed. */
  receive(log: ServeLog): Promise<Receiving>
}

/** One Channel, subscribed, and the two things ending it takes. */
export interface Receiving {
  /** Hand every Delivery back from here rather than finish with it. */
  stop(): void
  close(): Promise<void>
}

/**
 * Pair one Channel with the Transport its events arrive over. The one type
 * variable across both is the whole check that the Adapter can read what the
 * Transport delivers; a mismatch would otherwise run and ignore everything.
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

/** Everything `startRoma` takes, with a log wide enough for the subscriber too. */
export interface ServeOptions extends Omit<StartRomaOptions, 'log'> {
  readonly log?: ServeLog
}

/** roma, running and listening. */
export interface Serving extends Roma {
  /**
   * Stop taking messages on every Channel, then end every Resident Session, in
   * that order. Sessions survive this: their context is on disk.
   *
   * It does not wait for running Tasks. They are killed with the processes and
   * their Deliveries handed back, rather than finished with, so that a SIGTERM
   * does not take as long as the slowest Turn and nobody is told their Task
   * failed and then loses it. Where the Transport cannot redeliver, the work is
   * lost unannounced. Where it can, a Task that finished between the shutdown
   * starting and its answer being posted is answered *and* run again.
   */
  shutdown(): Promise<void>
}

/**
 * Start roma and put every Channel on its Transport: the whole program,
 * assembled.
 *
 * Nothing is subscribed until `startRoma` has passed the Startup Self-Check and
 * built the Cores; a boot that fails it throws from here with nothing
 * subscribed.
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
      // Enforced by `fence:serve-every-channel-stopped-first`.
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
  /** Enforced by `fence:serve-redelivery-dropped-while-in-flight`. */
  readonly #inFlight = new Set<string>()

  constructor({ core, channel, log }: IngressOptions<Event>) {
    this.#core = core
    this.#channel = channel
    this.#log = log
  }

  stop(): void {
    this.#stopping = true
  }

  /** Enforced by `fence:serve-take-never-rejects`. */
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

  /** Enforced by `fence:serve-take-never-rejects` and `fence:serve-shutdown-hands-back`. */
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
