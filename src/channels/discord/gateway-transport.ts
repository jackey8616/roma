import { reasonOf, writeToStderr, type OperatorLog } from '../../operator-log.js'
import type { Delivery, Receiver, Transport } from '../../transport.js'
import type { DiscordApi } from './discord-api.js'
import {
  asNumber,
  asRecord,
  asString,
  completedQuotation,
  type DiscordEvent,
  type DiscordEventLogRecord,
  type DiscordMessage,
} from './discord-events.js'

/**
 * The socket roma holds open to Discord, as much of it as roma uses.
 *
 * Four members: frames out, frames in, the close roma asks for and the close it
 * is told about. Narrow for `PubSubSubscription`'s reason — what the Transport
 * needs is a duplex of strings, and a port shaped like a WebSocket
 * implementation would make the double a test needs most of one.
 *
 * The close **code** is on both halves and is the one thing here that is not
 * incidental: it is how roma says whether it means to come back, and how Discord
 * says whether it will have it back.
 */
export interface GatewaySocket {
  /** Send one frame, already JSON. */
  send(frame: string): void
  /** Close, with the code that says whether roma means to resume. */
  close(code: number): void
  on(event: 'message', listener: (frame: string) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

/**
 * Open one connection to the Gateway.
 *
 * Takes the URL because resuming does not go to the same place a first
 * connection does: `READY` names a `resume_gateway_url`, and that is where a
 * resumed session lives.
 */
export type ConnectGateway = (url: string) => GatewaySocket

/** The three roma asks for: the guild's own state, and messages in both places. */
const GUILDS = 1 << 0
const GUILD_MESSAGES = 1 << 9
const DIRECT_MESSAGES = 1 << 12

/**
 * What roma identifies as, and — as much as anything here — what it refuses.
 *
 * `GUILDS` is what carries the guild's channel list, and the two message intents
 * are what carry the messages. **`MESSAGE_CONTENT` (`1 << 15`) is deliberately
 * not here**: it is privileged, its exceptions are exactly the messages roma
 * answers — a direct message, a message mentioning the app, and the app's own —
 * and it lives in a developer portal where nothing versions it and no test can
 * see it (ADR-0029). Asking for it is not a tuning knob; it is a decision with
 * an ADR against it.
 */
export const INTENTS = GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES

/**
 * How long roma waits before reconnecting, and the ceiling it doubles up to.
 *
 * A ceiling rather than a fixed wait because of the penalty at the other end: a
 * retry loop that does not back off spends its way into the invalid-request
 * limit, whose ban is not scoped to the connection that earned it (ADR-0029).
 */
export const RECONNECT_FLOOR_MS = 1_000
export const RECONNECT_CEILING_MS = 60_000

/** One thing the Gateway did that no Conversation will ever hear about. */
export type GatewayLogRecord =
  | {
      /**
       * A frame that is not a Gateway payload, or a payload roma cannot read.
       *
       * Discord has changed what it sends, or something on the socket is not
       * Discord. Dropped, so this record is the only trace it leaves — the
       * Gateway has no dead-letter and no redelivery, so a frame roma cannot
       * read is a frame that is simply gone (ADR-0028).
       */
      readonly event: 'gateway-undecodable'
      readonly reason: string
    }
  | {
      /**
       * The socket itself faulted.
       *
       * Written down rather than acted on: what follows an error is a close, and
       * the close is where reconnecting is decided.
       */
      readonly event: 'gateway-error'
      readonly reason: string
    }
  | {
      /**
       * The connection ended and roma is going back.
       *
       * `resuming` is the difference between a session Discord will replay into
       * and one roma has to start again, which is the difference between a
       * missed message and a lost one.
       */
      readonly event: 'gateway-disconnected'
      readonly code: number
      readonly resuming: boolean
    }
  | {
      /**
       * Discord closed the connection with a code that says not to come back.
       *
       * A bad token, or an intent roma is not approved for. roma stops
       * reconnecting: the alternative is a loop that cannot succeed, spending
       * its way toward a ban on every attempt. Nothing else says this — the
       * process stays up serving whatever other Channels it has, so without this
       * line a Discord that never connects looks exactly like a Discord nobody
       * is talking to.
       */
      readonly event: 'gateway-refused'
      readonly code: number
    }
  | {
      /**
       * A message arrived before roma knew enough to read it, and is being held.
       *
       * The classifier is unanswerable until the guild's channel list has
       * arrived: a channel roma has not been told about looks exactly like a
       * thread, and a top-level message read as a thread is a Session per
       * message for as long as it lasts. So the event waits rather than being
       * misread — and there is no queue behind this Transport to wait in, which
       * is why the wait is roma's own (ADR-0029).
       */
      readonly event: 'gateway-held'
      /** Which guild's state is missing, or null where what is missing is `READY`. */
      readonly guildId: string | null
    }
  | {
      /**
       * The receiver rejected, which it is not supposed to do.
       *
       * A bug on roma's side rather than a fact about the message. There is
       * nowhere to hand the work back to, so this line is the whole of what
       * happens next.
       */
      readonly event: 'gateway-unreceived'
      readonly messageId: string
      readonly reason: string
    }

/** Everything the Discord Channel says to an operator: its Transport's and its own. */
export type DiscordLogRecord = GatewayLogRecord | DiscordEventLogRecord

export interface GatewayTransportOptions {
  /**
   * The bot token, which is both the credential and the whole of the
   * authorisation.
   *
   * Sent on identify and on every resume. What it reaches is the guilds roma has
   * been added to, and that membership is the entire boundary (ADR-0029).
   */
  readonly token: string
  /** Where a first connection goes. A resumed one goes where `READY` says. */
  readonly url: string
  readonly connect: ConnectGateway
  /**
   * How roma reads the message behind a Quotation.
   *
   * The Transport's rather than the Adapter's because completing one is I/O and
   * `toIngress` does none — see `completedQuotation`.
   */
  readonly api: DiscordApi
  readonly log?: OperatorLog<DiscordLogRecord>
  /**
   * How much of the first heartbeat interval to wait, as a fraction.
   *
   * Discord asks for the first heartbeat after a random fraction of the interval
   * so that a fleet of connections does not beat in unison. Injectable only so
   * that a test can pin the moment; nothing else should pass it.
   */
  readonly jitter?: () => number
}

/** Discord's opcodes, as many of them as roma sends or reads. */
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

/** roma leaving on purpose, and roma leaving so that it can come back. */
const CLOSED_FOR_GOOD = 1000
const CLOSED_TO_RESUME = 4000

/**
 * A bad token, a shard roma does not have, an API version that is gone, an
 * intent roma is not approved for.
 *
 * **Never reconnect on one.** Each is a deployment fact rather than a network
 * one, so the next attempt fails identically — and attempts that cannot succeed
 * are what spend roma's way into the ban ADR-0029 warns about.
 */
const REFUSED_FOR_GOOD = new Set([4004, 4010, 4011, 4012, 4013, 4014])

/** The close codes that mean the session is gone, but the connection may return. */
const SESSION_LOST = new Set([4007, 4009])

/**
 * Discord's inbound path: one WebSocket, held open.
 *
 * ADR-0029's whole inbound decision, and it is the opposite of Chat's in
 * everything but what it owes the Core. Discord delivers messages **only** over
 * the Gateway, so roma opens a socket outward: no inbound port, no webhook
 * deadline, and nothing published onward — the Gateway *is* the Transport.
 *
 * What that costs is durability, and this is where the cost is paid. Settling is
 * a no-op in both directions because there is nowhere to hand a Delivery back
 * to; a resumed session replays what roma missed, which is why a Delivery is
 * named by the message's own snowflake and not by anything minted here
 * (ADR-0028).
 *
 * It decides two things Chat's Transport does not, and both for the same reason
 * — they need state that arrives over this socket. Which channels a guild has,
 * which is what tells a thread from a top-level message; and the words behind a
 * Quotation, which cost a REST call `toIngress` may not make. A message that
 * arrives before roma holds the first is **held**, never guessed at.
 */
export class GatewayTransport implements Transport<DiscordEvent> {
  readonly #token: string
  readonly #url: string
  readonly #connect: ConnectGateway
  readonly #api: DiscordApi
  readonly #log: OperatorLog<DiscordLogRecord>
  readonly #jitter: () => number

  #receiver: Receiver<DiscordEvent> | null = null
  #socket: GatewaySocket | null = null
  /** Whether roma is on its way down, and will not be reconnecting. */
  #closing = false

  /** Where a resume goes, as `READY` named it. */
  #resumeUrl: string | null = null
  /** The session a resume names, and the last event it saw. Both, or neither. */
  #session: string | null = null
  #sequence: number | null = null
  /** roma's own user id, which the Adapter strips the mention by. */
  #self: string | null = null

  #beating: ReturnType<typeof setTimeout> | null = null
  #reconnecting: ReturnType<typeof setTimeout> | null = null
  /**
   * Whether the last heartbeat was answered.
   *
   * **Never stop checking it.** It is the only thing that tells a quiet socket
   * from a dead one, and a socket nobody notices is dead stays open, delivers
   * nothing, and leaves roma looking healthy while it answers nobody.
   */
  #acknowledged = true
  /** How many times roma has reconnected without getting back on. */
  #attempts = 0

  /**
   * Which channels each guild has, which is the classifier and nothing else.
   *
   * **Channels, never threads.** The guild's channel list is complete and its
   * thread list holds only the active ones, so a thread archived for a day is in
   * neither — a classifier reading the thread list would call it a channel and
   * split its Session (ADR-0029).
   */
  readonly #channels = new Map<string, Set<string>>()
  /** Messages waiting for the state that makes them readable. See `gateway-held`. */
  #held: DiscordMessage[] = []

  constructor({ token, url, connect, api, log, jitter }: GatewayTransportOptions) {
    this.#token = token
    this.#url = url
    this.#connect = connect
    this.#api = api
    this.#log = log ?? writeToStderr
    this.#jitter = jitter ?? Math.random
  }

  /**
   * Open the socket and start delivering.
   *
   * Resolves once the socket is open rather than once Discord has said `READY`,
   * which is `Transport.receive`'s own distinction: what the caller is promised
   * is that nothing was listening before this was called. Waiting for `READY`
   * would make roma's boot wait on a round trip it can do nothing about.
   */
  receive(receiver: Receiver<DiscordEvent>): Promise<void> {
    this.#receiver = receiver
    this.#open(this.#url)
    return Promise.resolve()
  }

  /** Stop delivering, and mean it: nothing reconnects after this. */
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
      // Never thrown on, for `PubSubTransport`'s reason: an error listener that
      // threw would take the process down over a network blip that is about to
      // arrive as an ordinary close.
      this.#log({ event: 'gateway-error', reason: reasonOf(error) })
    })
    socket.on('close', (code) => {
      this.#closed(socket, code)
    })
  }

  /** One frame, read as far as an opcode. */
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

    // Every dispatch carries the sequence a resume asks to be replayed from, so
    // it is kept before anything is done with the payload — including for the
    // dispatches roma ignores, which are most of them.
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
        // Discord asking for one immediately, which it may do at any time.
        this.#beat()
        return
      case OP.reconnect:
        this.#reopen(CLOSED_TO_RESUME)
        return
      case OP.invalidSession:
        // The one payload whose whole content is a boolean: whether the session
        // roma just tried to resume is still there. Where it is not, forgetting
        // it here is what makes the next connection identify afresh.
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

  /** Discord has said hello: start beating, then say who roma is. */
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

  /** One dispatch, of the eight roma reads and the many it does not. */
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
        this.#take(payload)
        return
      default:
        return
    }
  }

  /** The guild's channels as `GUILD_CREATE` states them: complete, and replacing. */
  #seed(guild: Readonly<Record<string, unknown>>): void {
    const guildId = asString(guild['id'])
    if (guildId === null) return
    this.#channels.set(guildId, new Set(idsIn(guild['channels'])))
    // The active threads arrive in the same payload and are deliberately not
    // added — see `#channels`.
    this.#notChannels(guildId, idsIn(guild['threads']))
    this.#release()
  }

  /** Whatever these are, they are threads: take them out of the channel list. */
  #notChannels(guildId: string | null, ids: readonly string[]): void {
    const channels = this.#channelsOf(guildId)
    if (channels === undefined) return
    for (const id of ids) channels.delete(id)
  }

  #channelsOf(guildId: string | null): Set<string> | undefined {
    return guildId === null ? undefined : this.#channels.get(guildId)
  }

  /** Take one message, or hold it until roma can read it. */
  #take(message: DiscordMessage): void {
    if (asString(message['id']) === null) {
      this.#log({ event: 'gateway-undecodable', reason: 'a message arrived with no id' })
      return
    }
    if (this.#readable(message)) {
      void this.#deliver(message)
      return
    }
    this.#log({ event: 'gateway-held', guildId: asString(message['guild_id']) })
    this.#held.push(message)
  }

  /** Deliver whatever roma has learned enough to read, in the order it arrived. */
  #release(): void {
    const waiting = this.#held
    this.#held = []
    for (const message of waiting) {
      if (this.#readable(message)) void this.#deliver(message)
      else this.#held.push(message)
    }
  }

  /** Whether roma holds the state this message has to be read against. */
  #readable(message: DiscordMessage): boolean {
    if (this.#self === null) return false
    const guildId = asString(message['guild_id'])
    return guildId === null || this.#channels.has(guildId)
  }

  /**
   * One message, completed and handed over.
   *
   * **Never await this from the frame handler.** A Task takes minutes, and this
   * resolves when one is finished with — so awaiting it stops roma reading the
   * socket, heartbeats included, which is a connection Discord drops.
   *
   * **Never move the classifier below the fetch** either: it would then answer
   * about the guild as it stands a round trip later rather than as it stood when
   * the message arrived.
   */
  async #deliver(message: DiscordMessage): Promise<void> {
    const receiver = this.#receiver
    const self = this.#self
    const id = asString(message['id'])
    if (receiver === null || self === null || id === null) return

    const guildChannel = this.#guildChannel(message)
    const quotation = await completedQuotation(message, {
      fetchMessage: (channelId, messageId) => this.#api.message(channelId, messageId),
      log: this.#log,
    })

    const delivery: Delivery<DiscordEvent> = {
      // The event's own snowflake, never anything minted here: a resumed session
      // replays what roma missed, and this is what tells that replay from a
      // second message saying the same words (ADR-0028).
      id,
      event: { message, self, guildChannel, quotation },
      // **Never make either of these do anything.** A socket has nowhere to hand
      // a Delivery back to, so a `nack` that pretended otherwise would promise a
      // redelivery that never comes — and an `ack` on a Gateway event is a
      // sentence with no listener (ADR-0028).
      ack: () => {},
      nack: () => {},
    }
    try {
      await receiver(delivery)
    } catch (error) {
      this.#log({ event: 'gateway-unreceived', messageId: id, reason: reasonOf(error) })
    }
  }

  /** Whether this message arrived in one of its guild's own channels. */
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

  /** One heartbeat, or the end of a connection that stopped answering. See `#acknowledged`. */
  #beat(): void {
    if (!this.#acknowledged) {
      this.#reopen(CLOSED_TO_RESUME)
      return
    }
    this.#acknowledged = false
    this.#send({ op: OP.heartbeat, d: this.#sequence })
  }

  /** Both clears: the handle is a timeout until the first beat and an interval after it. */
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

  /** Leave, so that the close below brings roma back. */
  #reopen(code: number): void {
    const socket = this.#socket
    this.#stopBeating()
    socket?.close(code)
    // A socket that does not answer its own close — which is every real one,
    // since the close is a handshake — would otherwise leave roma disconnected
    // and waiting for an event that has not arrived yet. Reaching here twice is
    // what the two guards below are for.
    this.#closed(socket, code)
  }

  /**
   * The connection ended: come back, unless there is a reason not to.
   *
   * **Never drop the `socket` argument.** A close arrives from the connection it
   * happened to, which is not always the one roma is on — a socket abandoned a
   * second ago can answer its own close after the reconnection has already
   * opened another, and roma would end up holding two Gateways delivering
   * everything twice.
   */
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
      // Where `READY` said to go, which is not where the first connection went.
      this.#open((resuming ? this.#resumeUrl : null) ?? this.#url)
    }, delay)
  }

  /** Forget the session, so that the next connection identifies rather than resumes. */
  #forgetSession(): void {
    this.#session = null
    this.#sequence = null
  }
}

/** The ids of whatever is in this list, and nothing at all for what is not one. */
function idsIn(value: unknown): readonly string[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : []
  return entries.flatMap((entry) => {
    const id = asString(asRecord(entry)?.['id'])
    return id === null ? [] : [id]
  })
}
