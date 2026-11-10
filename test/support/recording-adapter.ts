import type {
  ChannelAdapter,
  ChannelCapabilities,
  IngressMessage,
  OutboundInstruction,
} from '../../src/channel-adapter.js'

export const UNREADABLE = Symbol('an event this Channel cannot read')

export interface OverflowTaken {
  readonly takeOverflow: string
}

export class RecordingAdapter implements ChannelAdapter<unknown> {
  readonly instructions: OutboundInstruction[] = []
  readonly capabilities: ChannelCapabilities
  readonly #refusing = new Map<OutboundInstruction['kind'], Error>()
  readonly #holding = new Map<OutboundInstruction['kind'], (() => void)[]>()

  constructor(capabilities: Partial<ChannelCapabilities> = {}) {
    this.capabilities = {
      messageMutation: true,
      stableConversationKey: true,
      ...capabilities,
    }
  }

  refuse(kind: OutboundInstruction['kind'], error: Error): void {
    this.#refusing.set(kind, error)
  }

  stopRefusing(kind: OutboundInstruction['kind']): void {
    this.#refusing.delete(kind)
  }

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
