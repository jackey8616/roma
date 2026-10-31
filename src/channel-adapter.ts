import type { Command } from './commands.js'

export interface PendingEnclosure {
  readonly name: string
  readonly from: string | null
  redeem(): Promise<Uint8Array>
}

export interface Quotation {
  readonly text: string
  readonly author: string | null
}

export interface IngressMessage {
  readonly conversationKey: string
  readonly caller: string
  readonly callerName: string | null
  readonly text: string
  readonly enclosures: readonly PendingEnclosure[]
  readonly quotation: Quotation | null
}

export type TaskProgress =
  | {
      readonly phase: 'queued'
      readonly position: number
    }
  | {
      readonly phase: 'working'
    }
  | {
      readonly phase: 'compacting'
    }
  | {
      readonly phase: 'thinking'
      readonly estimatedTokens: number
    }
  | {
      readonly phase: 'tool'
      readonly tool: string
    }
  | {
      readonly phase: 'writing'
      readonly characters: number
    }

export interface TaskAddress {
  readonly taskId: string
  readonly conversationKey: string
  readonly caller: string
  readonly callerName: string | null
}

export type OutboundInstruction = TaskAddress &
  (
    | {
        readonly kind: 'progress'
        readonly progress: TaskProgress
      }
    | {
        readonly kind: 'result'
        readonly text: string
        readonly overflowCostUsd?: number | null
      }
    | {
        readonly kind: 'blocked'
        readonly resetsAt: number
        readonly overflowOffered: boolean
      }
    | {
        readonly kind: 'overflow-refused'
        readonly capUsd: number
        readonly spentUsd: number
      }
    | {
        readonly kind: 'context-full'
      }
    | {
        readonly kind: 'failure'
        readonly reason: string
      }
    | {
        readonly kind: 'stopped'
      }
    | {
        readonly kind: 'command-outcome'
        readonly command: Exclude<Command, 'model'>
        readonly carriedOut: boolean
      }
    | {
        readonly kind: 'choice'
        readonly text: string
        readonly chooses: Extract<Command, 'model' | 'effort' | 'caveman'>
        readonly options: readonly string[]
        readonly refused: string | null
      }
  )

export interface ChannelCapabilities {
  readonly messageMutation: boolean
  readonly stableConversationKey: boolean
}

export interface ChannelAdapter<Event = unknown> {
  readonly capabilities: ChannelCapabilities
  toIngress(event: Event): IngressMessage | null
  toOverflowTaken?(event: Event): string | null
  deliver(instruction: OutboundInstruction): void | Promise<void>
}
