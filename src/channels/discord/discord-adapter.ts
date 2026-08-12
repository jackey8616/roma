import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../channel-adapter.js'
import type { DiscordApi } from './discord-api.js'
import { readIngressMessage, type DiscordEvent } from './discord-events.js'

export interface DiscordAdapterOptions {
  /**
   * How roma reaches Discord over HTTP.
   *
   * Here for the Enclosures alone today: an attachment's bytes are redeemed long
   * after the message was read, so the Adapter has to be able to hand out a way
   * of fetching them rather than the bytes (ADR-0011).
   */
  readonly api: DiscordApi
}

/**
 * Discord, and one of the two modules in roma that knows Discord exists.
 *
 * A Discord event goes in and an ingress message comes out. Everything
 * Discord-specific is on this side of it — snowflakes, mentions, guilds — and
 * nothing on the other side has ever heard of any of it.
 *
 * It keeps no record of who is talking to whom, which is ADR-0029's claim that
 * Discord needs no adapter-side identity storage, and it can afford that for a
 * reason Chat could not have used: a Conversation Key *is* a channel id, or the
 * id of a message a thread is about to take, because a thread and the message it
 * was started from share one id. So the key minted before the thread exists is
 * the id the thread will have, and no lookup and no state stand behind it.
 *
 * The other module is the Transport, unlike Chat, where the Adapter is the whole
 * of the Channel. `GatewayTransport` decides the two things a synchronous reader
 * cannot: whether a channel is one of the guild's, and what a Quotation says.
 */
export class DiscordAdapter implements ChannelAdapter<DiscordEvent> {
  /**
   * Both true, and both ADR-0029's declarations rather than hopes: Discord can
   * edit a message it has posted, so progress reporting runs in its full form;
   * and a channel id and a message id are both permanent, so no Conversation Key
   * has to be minted or persisted here.
   */
  readonly capabilities: ChannelCapabilities = {
    messageMutation: true,
    stableConversationKey: true,
  }

  readonly #api: DiscordApi

  constructor({ api }: DiscordAdapterOptions) {
    this.#api = api
  }

  /**
   * One Discord event as a message for the Core, or null if roma should not
   * answer it.
   *
   * Which events those are is `readIngressMessage`'s business. What matters here
   * is that the Core never sees an event: by this point a guild, a channel, a
   * thread and an @-mention have become a key, a Caller and some text.
   */
  toIngress(event: DiscordEvent): IngressMessage | null {
    return readIngressMessage(event, {
      // Bound rather than called: `toIngress` stays synchronous, and what an
      // Enclosure costs is paid once the Core knows the Session and knows the
      // bytes are wanted (ADR-0011).
      download: (url) => this.#api.download(url),
    })
  }

  /**
   * Nothing yet, and it says so by rejecting.
   *
   * **Stage 2 is inbound only** (#179): posting a Result, splitting it at 2000
   * characters, opening the thread a top-level Conversation Key names and
   * drawing the Menus are all #180's, and none of them is sketched here. What is
   * here is the honest answer to the interface's own sentence — *"Rejecting means
   * it reached nobody"* — which is exactly what is true of every instruction
   * until that lands. A silent no-op would be the lie: the Core would take it for
   * a Conversation that had been told, and nobody anywhere would be waiting for
   * an answer that was never coming.
   */
  deliver(instruction: OutboundInstruction): Promise<void> {
    return Promise.reject(
      new Error(
        `roma cannot post to Discord yet — outbound is #180, and this ${instruction.kind} reached nobody`,
      ),
    )
  }
}
