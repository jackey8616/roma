import type { MintsTokens } from '../reach.js'

/** The Depot, as the boot proof found it. */
export interface Depot {
  /** The folder id, which is what the agent names as a parent on a create. */
  readonly id: string
  /** What it is called, so that the agent can say where it put something. */
  readonly name: string
}

/**
 * The only thing that holds the Document Reach's key. Startup asks for the
 * Depot once, and blocks the boot if the answer is wrong; everything after that
 * asks only for tokens.
 */
export interface DocumentMinter extends MintsTokens {
  /** How the identity names itself, as an operator would recognise it. */
  readonly account: string
  /**
   * Prove the Depot is there and that this identity may put something in it.
   * Throws `DepotUnreachable`, saying what an operator must fix, rather than
   * returning a folder it could not reach.
   */
  depot(): Promise<Depot>
}
