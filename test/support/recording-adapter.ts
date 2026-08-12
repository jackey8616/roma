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
  /** Instruction kinds this Channel is holding, and what will let each delivery go. */
  readonly #holding = new Map<OutboundInstruction['kind'], (() => void)[]>()

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

  /** And take them again, the way a Channel that has come back does. */
  stopRefusing(kind: OutboundInstruction['kind']): void {
    this.#refusing.delete(kind)
  }

  /**
   * Make deliveries of one kind hang until the returned function is called.
   *
   * A slow Channel, which is the only condition under which the order of
   * instructions is observable at all: deliveries this Adapter takes
   * instantly can never queue behind one another, so a test cannot otherwise
   * reach the state where roma has something to send and the Channel is still
   * taking the last thing.
   *
   * A held instruction is still recorded on arrival, the same as an unheld
   * one. What matters about a late update is that roma handed it over at all —
   * a real Adapter acts on it the moment it arrives, and by then the
   * acknowledgement it meant to edit may be finished with.
   */
  hold(kind: OutboundInstruction['kind']): () => void {
    const held: (() => void)[] = []
    this.#holding.set(kind, held)
    return () => {
      this.#holding.delete(kind)
      for (const release of held.splice(0)) release()
    }
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
    const held = this.#holding.get(instruction.kind)
    this.instructions.push(instruction)
    if (held !== undefined) return new Promise<void>((release) => held.push(release))
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
