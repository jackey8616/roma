import type { ChannelAdapter, IngressMessage } from './channel-adapter.js'
import type { Core, CoreLogRecord } from './core.js'
import { reasonOf, writeToStderr, type OperatorLog } from './operator-log.js'
import type { PoolLogRecord } from './session-pool.js'
import type { ShimLogRecord } from './shim-server.js'
import type { SelfCheckLogRecord } from './startup-self-check.js'
import {
  startRoma,
  type IsolationLogRecord,
  type ReachLogRecord,
  type Roma,
  type StartRomaOptions,
} from './startup.js'
import type { Delivery, Settle, Transport } from './transport.js'

export type IngressLogRecord =
  | {
      readonly event: 'ingress-unreadable'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      readonly event: 'ingress-ignored'
      readonly deliveryId: string
    }
  | {
      readonly event: 'ingress-redelivered'
      readonly deliveryId: string
    }
  | {
      readonly event: 'ingress-failed'
      readonly deliveryId: string
      readonly reason: string
    }
  | {
      readonly event: 'ingress-interrupt-unfinished'
      readonly windowMs: number
    }
  | {
      readonly event: 'ingress-unsettled'
      readonly deliveryId: string
      readonly settle: Settle
      readonly reason: string
    }

export type ServeLog = OperatorLog<
  | PoolLogRecord
  | CoreLogRecord
  | IngressLogRecord
  | ShimLogRecord
  | ReachLogRecord
  | IsolationLogRecord
  | SelfCheckLogRecord
>

export interface ChannelBinding {
  coreOver(build: (channel: ChannelAdapter) => Core): BoundChannel
}

export interface BoundChannel {
  readonly core: Core
  receive(log: ServeLog): Promise<Receiving>
}

export interface Receiving {
  stop(): void
  interrupt(): Promise<void>
  close(): Promise<void>
}

export const INTERRUPT_WINDOW_MS = 10_000

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
          return {
            stop: () => ingress.stop(),
            interrupt: () => (transport.redelivers ? Promise.resolve() : core.interrupt()),
            close: () => transport.close(),
          }
        },
      }
    },
  }
}

export interface ServeOptions extends Omit<StartRomaOptions, 'log'> {
  readonly log?: ServeLog
  readonly interruptWindowMs?: number
}

export interface Serving extends Roma {
  shutdown(): Promise<void>
}

export async function serve(options: ServeOptions): Promise<Serving> {
  const { log = writeToStderr, interruptWindowMs = INTERRUPT_WINDOW_MS, ...startOptions } = options
  const roma = await startRoma({ ...startOptions, log })

  const receiving: Receiving[] = []
  try {
    for (const channel of roma.channels) receiving.push(await channel.receive(log))
  } catch (error) {
    await Promise.allSettled(receiving.map((channel) => channel.close()))
    await roma.shutdown()
    throw error
  }

  return {
    ...roma,
    shutdown: async () => {
      for (const channel of receiving) channel.stop()
      const deadline = Date.now() + interruptWindowMs
      const interrupting = () =>
        within(
          deadline - Date.now(),
          Promise.allSettled(receiving.map((channel) => channel.interrupt())),
        )
      let told = await interrupting()
      const closed = await Promise.allSettled(receiving.map((channel) => channel.close()))
      if (told) told = await interrupting()
      if (!told) log({ event: 'ingress-interrupt-unfinished', windowMs: interruptWindowMs })
      await roma.shutdown()
      for (const closing of closed) {
        if (closing.status === 'rejected') throw closing.reason
      }
    },
  }
}

function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(false)
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })
  return Promise.race([work.then(() => true), expired]).finally(() => clearTimeout(timer))
}

interface IngressOptions<Event> {
  readonly core: Core
  readonly channel: ChannelAdapter<Event>
  readonly log: ServeLog
}

class Ingress<Event> {
  readonly #core: Core
  readonly #channel: ChannelAdapter<Event>
  readonly #log: ServeLog
  #stopping = false
  readonly #inFlight = new Set<string>()

  constructor({ core, channel, log }: IngressOptions<Event>) {
    this.#core = core
    this.#channel = channel
    this.#log = log
  }

  stop(): void {
    this.#stopping = true
  }

  async take(delivery: Delivery<Event>): Promise<void> {
    const { id } = delivery
    if (this.#inFlight.has(id)) {
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
