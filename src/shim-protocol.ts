export type CredentialWanted = 'code' | 'cloud' | 'documents'

export interface ShimRequest {
  readonly session: string
  readonly operation: 'get' | 'erase'
  readonly path?: string | null
  readonly token?: string | null
  readonly credential?: CredentialWanted
}

export interface ShimResponse {
  readonly token: string | null
  readonly reason?: string
  readonly expiresAt?: number
  readonly account?: string | null
}

export const MINTER_SOCKET_VAR = 'ROMA_MINTER_SOCKET'
export const SESSION_ID_VAR = 'ROMA_SESSION_ID'

export function socketPathIn(directory: string): string {
  return `${directory}/minter.sock`
}
