import type { MintsTokens } from '../reach.js'

export interface Depot {
  readonly id: string
  readonly name: string
}

export interface DocumentMinter extends MintsTokens {
  readonly account: string
  depot(): Promise<Depot>
}
