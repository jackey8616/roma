import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../src/channel-adapter.js'

/**
 * The event this Channel cannot read at all.
 *
 * A stand-in for the real thing an Adapter would throw on — a Conversation Key
 * in the wrong shape, a payload whose fields are not what its Channel documents.
 * Named rather than improvised per test, because "unreadable" and "not one roma
 * answers" are different endings and a test asserting on one should be unable to
 * write the other by accident.
 */
export const UNREADABLE = Symbol('an event this Channel cannot read')

/** What a test hands in to say "this event is somebody taking Overflow". */
export interface OverflowTaken {
  readonly takeOverflow: string
}

/**
 * A Channel that does nothing but remember what it was asked to do.
 *
 * This is the far side of seam 1: a message goes into the Core and what comes
 * out is a list of outbound instructions, with no Channel API, no network, and
 * nothing to stub. A test asserting on `instructions` is asserting on exactly
 * what a person on the other end would have seen.
 *
 * Its own "Channel events" are ingress messages already, because inbound
 * translation proper is the one part of the Adapter contract seam 1 does not
 * exercise — that belongs to the Channel's own seam, where the events are real.
 * What it does model is the three answers inbound translation can give, since
 * the ingress subscriber settles a delivery differently for each: a message, not
 * one roma answers, or one this Channel cannot read.
 */
export class RecordingAdapter implements ChannelAdapter<unknown> {
  readonly instructions: OutboundInstruction[] = []
  readonly capabilities: ChannelCapabilities
  /** Instruction kinds this Channel is currently refusing, and with what. */
  readonly #refusing = new Map<OutboundInstruction['kind'], Error>()

  constructor(capabilities: Partial<ChannelCapabilities> = {}) {
    this.capabilities = {
      messageMutation: true,
      stableConversationKey: true,
      ...capabilities,
    }
  }

  /** Make every delivery of one kind reject, the way an unreachable Channel does. */
  refuse(kind: OutboundInstruction['kind'], error: Error): void {
    this.#refusing.set(kind, error)
  }

  toIngress(event: unknown): IngressMessage | null {
    if (event === UNREADABLE) throw new Error('this Channel cannot read that event')
    return isIngressMessage(event) ? event : null
  }

  toOverflowTaken(event: unknown): string | null {
    if (event === UNREADABLE) throw new Error('this Channel cannot read that event')
    return isOverflowTaken(event) ? event.takeOverflow : null
  }

  deliver(instruction: OutboundInstruction): void | Promise<void> {
    const refusal = this.#refusing.get(instruction.kind)
    if (refusal !== undefined) return Promise.reject(refusal)
    this.instructions.push(instruction)
  }
}

function isIngressMessage(event: unknown): event is IngressMessage {
  if (typeof event !== 'object' || event === null) return false
  const candidate = event as Partial<IngressMessage>
  return typeof candidate.conversationKey === 'string' && typeof candidate.text === 'string'
}

function isOverflowTaken(event: unknown): event is OverflowTaken {
  if (typeof event !== 'object' || event === null) return false
  return typeof (event as Partial<OverflowTaken>).takeOverflow === 'string'
}
