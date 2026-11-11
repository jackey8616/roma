import type { Grant, GrantAsked } from './grants.js'

export type CredentialWanted = 'code' | 'cloud' | 'documents'

export type ShimOperation = 'get' | 'erase' | 'grant' | 'grant-status'

export interface ShimRequest {
  readonly session: string
  readonly operation: ShimOperation
  readonly path?: string | null
  readonly token?: string | null
  readonly credential?: CredentialWanted
  readonly grant?: GrantAsked | null
  readonly grantName?: string | null
}

export interface ShimResponse {
  readonly token: string | null
  readonly reason?: string
  readonly expiresAt?: number
  readonly account?: string | null
  readonly grant?: Grant
}

export const MINTER_SOCKET_VAR = 'ROMA_MINTER_SOCKET'
export const SESSION_ID_VAR = 'ROMA_SESSION_ID'

export function socketPathIn(directory: string): string {
  return `${directory}/minter.sock`
}

export function seatSocketPathIn(directory: string, seat: number): string {
  return `${directory}/seat-${String(seat).padStart(2, '0')}.sock`
}
