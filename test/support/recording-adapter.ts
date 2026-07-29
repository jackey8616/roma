import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../src/channel-adapter.js'

/**
 * A Channel that does nothing but remember what it was asked to do.
 *
 * This is the far side of seam 1: a message goes into the Core and what comes
 * out is a list of outbound instructions, with no Channel API, no network, and
 * nothing to stub. A test asserting on `instructions` is asserting on exactly
 * what a person on the other end would have seen.
 *
 * Its own "Channel events" are ingress messages already, because inbound
 * translation is the one part of the Adapter contract seam 1 does not exercise —
 * that belongs to the Channel's own seam, where the events are real.
 */
export class RecordingAdapter implements ChannelAdapter<IngressMessage> {
  readonly instructions: OutboundInstruction[] = []
  readonly capabilities: ChannelCapabilities

  constructor(capabilities: Partial<ChannelCapabilities> = {}) {
    this.capabilities = {
      messageMutation: true,
      stableConversationKey: true,
      ...capabilities,
    }
  }

  toIngress(event: IngressMessage): IngressMessage {
    return event
  }

  deliver(instruction: OutboundInstruction): void {
    this.instructions.push(instruction)
  }
}
