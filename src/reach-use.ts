/**
 * Which Tasks obtained one credential, until their Audit Record has said so.
 *
 * Between the socket and the Audit Record, because the two ends know different
 * things and neither may reach the other: `ShimServer` knows a request arrived
 * and which Task the Task Queue says its Session was running, the Core knows a
 * Task has ended and is writing the line about it, and a Core that could be
 * asked "did this Task talk to Google" would be a Core that knows there is a
 * Google.
 *
 * Which credential is worth remembering is this layer's question rather than the
 * socket's (ADR-0020 §6), and what is worth remembering differs per credential —
 * the forge's answer is a list of repositories — so this is *built* twice rather
 * than *copied* twice.
 *
 * **Never turn this into a tally.** A `Set` is the shape that cannot accidentally
 * become one; why a count would be wrong, and what this cannot see at all, are
 * `audit-log.ts`'s `cloudReach` and ADR-0015 §10.
 */
export class ReachUse {
  readonly #tasks = new Set<string>()

  /**
   * A credential was handed to whatever this Task's Session was running.
   *
   * Null is a request belonging to no running Task — a background process the
   * agent left going, which has no Audit Record to land on.
   */
  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  /** Whether this Task used the Reach, asked once and then forgotten. */
  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}
