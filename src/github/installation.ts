import type { MintsTokens } from '../reach.js'

export interface Installation {
  readonly account: string
  readonly repositories: readonly string[]
}

export interface InstallationMinter extends MintsTokens {
  installation(): Promise<Installation>
}
