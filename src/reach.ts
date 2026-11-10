import type { CredentialWanted } from './shim-protocol.js'

export interface MintedToken {
  readonly token: string
  readonly expiresAt: number
}

export interface MintsTokens {
  mint(): Promise<MintedToken>
}

export interface ReachProof {
  readonly account: string | null
}

interface Reaching<C extends CredentialWanted> {
  readonly credential: C
  prove(): Promise<ReachProof>
  announce(): string
}

export type AvailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly minter: MintsTokens
}

export type UnavailableReach<C extends CredentialWanted = CredentialWanted> = Reaching<C> & {
  readonly unavailable: string
}

export type Reach<C extends CredentialWanted = CredentialWanted> =
  AvailableReach<C> | UnavailableReach<C>

export interface Reaches {
  readonly code: AvailableReach<'code'>
  readonly cloud: Reach<'cloud'>
  readonly documents: Reach<'documents'>
}

export function eachReach(reaches: Reaches): readonly Reach[] {
  return [reaches.code, reaches.cloud, reaches.documents]
}
