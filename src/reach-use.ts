/**
 * Which Tasks obtained one credential, until their Audit Record has said so.
 *
 * Between the socket and the Audit Record, and it exists because the two ends
 * know different things. `ShimServer` knows a request arrived and which Task the
 * Task Queue says its Session was running; the Core knows when a Task has ended
 * and is writing the line about it. Neither can reach the other, and neither
 * should — a Core that could be asked "did this Task talk to Google" would be a
 * Core that knows there is a Google.
 *
 * The socket reports **every** credential it serves and one of these keeps one
 * of them (ADR-0020 §6). Which one is interesting is this module's question
 * rather than the socket's, and what is worth remembering differs per
 * credential: the forge's wants a list of repositories, and the Cloud Reach's
 * and the Document Reach's each want a yes. So this is *built* twice rather than
 * *copied* twice — a second Reach wanting a boolean is what turned "the cloud's
 * memory" into "the boolean-shaped one".
 *
 * **A yes or a no, and deliberately not a count.** One token does unlimited API
 * calls for an hour, so a number of mints is not a measure of activity and would
 * be read as one (ADR-0015 §10, ADR-0022 §9). A `Set` is the shape that cannot
 * accidentally become a tally.
 *
 * **It records the ordinary path only.** An agent that reaches a metadata server
 * itself, or signs an assertion of its own, is invisible here — which is the
 * same honesty the `Requested-by:` trailer carries.
 */
export class ReachUse {
  readonly #tasks = new Set<string>()

  /**
   * A credential was handed to whatever this Task's Session was running.
   *
   * Null is dropped rather than recorded against the nearest Task — a request
   * belonging to no running Task is a background process the agent left going,
   * and there is no Audit Record for it to land on. The same rule the Operator
   * Log applies when it writes such a request down as belonging to no Task.
   */
  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  /**
   * Whether this Task used the Reach, asked once and then forgotten.
   *
   * Read-and-forget rather than read, so that the set holds only Tasks that have
   * not yet been written down. A Task writes at most two Audit Records — one per
   * credential that paid — and both say the same thing about a Reach, so the
   * Core asks once and carries the answer.
   *
   * What can still accumulate is a Task that minted and then ended without a
   * record, which the Core has no path to: every ending it has writes one.
   */
  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}
