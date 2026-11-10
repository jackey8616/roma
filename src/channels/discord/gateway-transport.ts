import { reasonOf, writeToStderr, type OperatorLog } from '../../operator-log.js'
import type { Delivery, Receiver, Transport } from '../../transport.js'
import type { DiscordApi } from './discord-api.js'
import {
  asNumber,
  asRecord,
  asString,
  completedQuotation,
  readInteraction,
  type DiscordEvent,
  type DiscordEventLogRecord,
  type DiscordMessage,
  type DiscordPress,
  type Interaction,
} from './discord-events.js'

export interface GatewaySocket {
  send(frame: string): void
  close(code: number): void
  on(event: 'message', listener: (frame: string) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export type ConnectGateway = (url: string) => GatewaySocket

const GUILDS = 1 << 0
const GUILD_MESSAGES = 1 << 9
const DIRECT_MESSAGES = 1 << 12

export const INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES

export const RECONNECT_FLOOR_MS = 1_000
export const RECONNECT_CEILING_MS = 60_000

export type GatewayLogRecord =
  | {
      readonly event: 'gateway-undecodable'
      readonly reason: string
    }
  | {
      readonly event: 'gateway-error'
      readonly reason: string
    }
  | {
      readonly event: 'gateway-disconnected'
      readonly code: number
      readonly resuming: boolean
    }
  | {
      readonly event: 'gateway-refused'
      readonly code: number
    }
  | {
      readonly event: 'gateway-held'
      readonly guildId: string | null
    }
  | {
      readonly event: 'gateway-unreceived'
      readonly messageId: string
      readonly reason: string
    }
  | {
      readonly event: 'press-unacknowledged'
      readonly reason: string
    }

export type GatewayLog = OperatorLog<GatewayLogRecord | DiscordEventLogRecord>

export interface GatewayTransportOptions {
  readonly token: string
  readonly url: string
  readonly connect: ConnectGateway
  readonly api: DiscordApi
  readonly log?: GatewayLog
  readonly jitter?: () => number
}

const OP = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const

const CLOSED_FOR_GOOD = 1000
const CLOSED_TO_RESUME = 4000

const REFUSED_FOR_GOOD = new Set([4004, 4010, 4011, 4012, 4013, 4014])

const SESSION_LOST = new Set([4007, 4009])

interface Pending {
  readonly id: string
  readonly message: DiscordMessage
  readonly press: DiscordPress | null
}

export class GatewayTransport implements Transport<DiscordEvent> {
  readonly #token: string
  readonly #url: string
  readonly #connect: ConnectGateway
  readonly #api: DiscordApi
  readonly #log: GatewayLog
  readonly #jitter: () => number

  #receiver: Receiver<DiscordEvent> | null = null
  #socket: GatewaySocket | null = null
  #closing = false

  #resumeUrl: string | null = null
  #session: string | null = null
  #sequence: number | null = null
  #self: string | null = null

  #beating: ReturnType<typeof setTimeout> | null = null
  #reconnecting: ReturnType<typeof setTimeout> | null = null
  #acknowledged = true
  #attempts = 0

  readonly #channels = new Map<string, Set<string>>()
  #held: Pending[] = []

  constructor({ token, url, connect, api, log, jitter }: GatewayTransportOptions) {
    this.#token = token
    this.#url = url
    this.#connect = connect
    this.#api = api
    this.#log = log ?? writeToStderr
    this.#jitter = jitter ?? Math.random
  }

  receive(receiver: Receiver<DiscordEvent>): Promise<void> {
    this.#receiver = receiver
    this.#open(this.#url)
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.#closing = true
    this.#receiver = null
    this.#stopBeating()
    if (this.#reconnecting !== null) clearTimeout(this.#reconnecting)
    this.#reconnecting = null
    const socket = this.#socket
    this.#socket = null
    socket?.close(CLOSED_FOR_GOOD)
    return Promise.resolve()
  }

  #open(url: string): void {
    const socket = this.#connect(url)
    this.#socket = socket
    socket.on('message', (frame) => {
      this.#read(frame)
    })
    socket.on('error', (error) => {
      this.#log({ event: 'gateway-error', reason: reasonOf(error) })
    })
    socket.on('close', (code) => {
      this.#closed(socket, code)
    })
  }

  #read(frame: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch (error) {
      this.#log({ event: 'gateway-undecodable', reason: reasonOf(error) })
      return
    }
    const payload = asRecord(parsed)
    const op = asNumber(payload?.['op'])
    if (payload === null || op === null) {
      this.#log({ event: 'gateway-undecodable', reason: 'the frame carries no opcode' })
      return
    }

    const sequence = asNumber(payload['s'])
    if (sequence !== null) this.#sequence = sequence

    switch (op) {
      case OP.hello:
        this.#hello(asNumber(asRecord(payload['d'])?.['heartbeat_interval']))
        return
      case OP.heartbeatAck:
        this.#acknowledged = true
        return
      case OP.heartbeat:
        this.#beat()
        return
      case OP.reconnect:
        this.#reopen(CLOSED_TO_RESUME)
        return
      case OP.invalidSession:
        if (payload['d'] !== true) this.#forgetSession()
        this.#reopen(payload['d'] === true ? CLOSED_TO_RESUME : CLOSED_FOR_GOOD)
        return
      case OP.dispatch:
        this.#dispatch(asString(payload['t']), asRecord(payload['d']))
        return
      default:
        return
    }
  }

  #hello(interval: number | null): void {
    if (interval === null) {
      this.#log({ event: 'gateway-undecodable', reason: 'hello carried no heartbeat interval' })
      return
    }
    this.#startBeating(interval)

    if (this.#session !== null && this.#sequence !== null) {
      this.#send({
        op: OP.resume,
        d: { token: this.#token, session_id: this.#session, seq: this.#sequence },
      })
      return
    }
    this.#send({
      op: OP.identify,
      d: {
        token: this.#token,
        intents: INTENTS,
        properties: { os: process.platform, browser: 'roma', device: 'roma' },
      },
    })
  }

  #dispatch(name: string | null, payload: Readonly<Record<string, unknown>> | null): void {
    if (payload === null) return
    switch (name) {
      case 'READY':
        this.#session = asString(payload['session_id'])
        this.#resumeUrl = asString(payload['resume_gateway_url'])
        this.#self = asString(asRecord(payload['user'])?.['id'])
        this.#attempts = 0
        this.#release()
        return
      case 'RESUMED':
        this.#attempts = 0
        return
      case 'GUILD_CREATE':
        this.#seed(payload)
        return
      case 'CHANNEL_CREATE': {
        const id = asString(payload['id'])
        if (id !== null) this.#channelsOf(asString(payload['guild_id']))?.add(id)
        return
      }
      case 'CHANNEL_DELETE': {
        const id = asString(payload['id'])
        if (id !== null) this.#channelsOf(asString(payload['guild_id']))?.delete(id)
        return
      }
      case 'THREAD_CREATE': {
        const id = asString(payload['id'])
        if (id !== null) this.#notChannels(asString(payload['guild_id']), [id])
        return
      }
      case 'THREAD_LIST_SYNC':
        this.#notChannels(asString(payload['guild_id']), idsIn(payload['threads']))
        return
      case 'MESSAGE_CREATE':
        this.#message(payload)
        return
      case 'INTERACTION_CREATE': {
        const interaction = readInteraction(payload)
        if (interaction !== null) void this.#pressed(interaction)
        return
      }
      default:
        return
    }
  }

  #seed(guild: Readonly<Record<string, unknown>>): void {
    const guildId = asString(guild['id'])
    if (guildId === null) return
    this.#channels.set(guildId, new Set(idsIn(guild['channels'])))
    this.#notChannels(guildId, idsIn(guild['threads']))
    this.#release()
  }

  #notChannels(guildId: string | null, ids: readonly string[]): void {
    const channels = this.#channelsOf(guildId)
    if (channels === undefined) return
    for (const id of ids) channels.delete(id)
  }

  #channelsOf(guildId: string | null): Set<string> | undefined {
    return guildId === null ? undefined : this.#channels.get(guildId)
  }

  #message(message: DiscordMessage): void {
    const id = asString(message['id'])
    if (id === null) {
      this.#log({ event: 'gateway-undecodable', reason: 'a message arrived with no id' })
      return
    }
    this.#take({ id, message, press: null })
  }

  async #pressed({ id, token, message, press }: Interaction): Promise<void> {
    try {
      await this.#api.acknowledgePress(id, token)
    } catch (error) {
      this.#log({ event: 'press-unacknowledged', reason: reasonOf(error) })
    }
    this.#take({ id, message, press })
  }

  #take(pending: Pending): void {
    if (this.#readable(pending)) {
      void this.#deliver(pending)
      return
    }
    this.#log({ event: 'gateway-held', guildId: asString(pending.message['guild_id']) })
    this.#held.push(pending)
  }

  #release(): void {
    const waiting = this.#held
    this.#held = []
    for (const pending of waiting) {
      if (this.#readable(pending)) void this.#deliver(pending)
      else this.#held.push(pending)
    }
  }

  #readable({ message, press }: Pending): boolean {
    if (this.#self === null) return false
    if (press !== null) return true
    const guildId = asString(message['guild_id'])
    return guildId === null || this.#channels.has(guildId)
  }

  async #deliver({ id, message, press }: Pending): Promise<void> {
    const receiver = this.#receiver
    const self = this.#self
    if (receiver === null || self === null) return

    const guildChannel = this.#guildChannel(message)
    const quotation =
      press !== null
        ? null
        : await completedQuotation(message, {
            fetchMessage: (channelId, messageId) => this.#api.message(channelId, messageId),
            log: this.#log,
          })

    const delivery: Delivery<DiscordEvent> = {
      id,
      event: { message, self, guildChannel, quotation, press },
      ack: () => {},
      nack: () => {},
    }
    try {
      await receiver(delivery)
    } catch (error) {
      this.#log({ event: 'gateway-unreceived', messageId: id, reason: reasonOf(error) })
    }
  }

  #guildChannel(message: DiscordMessage): boolean {
    const channelId = asString(message['channel_id'])
    const channels = this.#channelsOf(asString(message['guild_id']))
    return channelId !== null && channels?.has(channelId) === true
  }

  #startBeating(interval: number): void {
    this.#stopBeating()
    this.#acknowledged = true
    this.#beating = setTimeout(() => {
      this.#beat()
      this.#beating = setInterval(() => {
        this.#beat()
      }, interval)
    }, interval * this.#jitter())
  }

  #beat(): void {
    if (!this.#acknowledged) {
      this.#reopen(CLOSED_TO_RESUME)
      return
    }
    this.#acknowledged = false
    this.#send({ op: OP.heartbeat, d: this.#sequence })
  }

  #stopBeating(): void {
    if (this.#beating !== null) {
      clearTimeout(this.#beating)
      clearInterval(this.#beating)
    }
    this.#beating = null
  }

  #send(payload: Readonly<Record<string, unknown>>): void {
    this.#socket?.send(JSON.stringify(payload))
  }

  #reopen(code: number): void {
    const socket = this.#socket
    this.#stopBeating()
    socket?.close(code)
    this.#closed(socket, code)
  }

  #closed(socket: GatewaySocket | null, code: number): void {
    if (socket !== null && socket !== this.#socket) return
    this.#socket = null
    this.#stopBeating()
    if (this.#closing || this.#reconnecting !== null) return

    if (REFUSED_FOR_GOOD.has(code)) {
      this.#log({ event: 'gateway-refused', code })
      return
    }
    if (SESSION_LOST.has(code)) this.#forgetSession()

    const resuming = this.#session !== null && this.#sequence !== null
    this.#log({ event: 'gateway-disconnected', code, resuming })

    const delay = Math.min(RECONNECT_FLOOR_MS * 2 ** this.#attempts, RECONNECT_CEILING_MS)
    this.#attempts += 1
    this.#reconnecting = setTimeout(() => {
      this.#reconnecting = null
      this.#open((resuming ? this.#resumeUrl : null) ?? this.#url)
    }, delay)
  }

  #forgetSession(): void {
    this.#session = null
    this.#sequence = null
  }
}

function idsIn(value: unknown): readonly string[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : []
  return entries.flatMap((entry) => {
    const id = asString(asRecord(entry)?.['id'])
    return id === null ? [] : [id]
  })
}
