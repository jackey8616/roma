/** Which Tasks obtained one credential, until their Audit Record has said so. */
export class ReachUse {
  readonly #tasks = new Set<string>()

  /**
   * A credential was handed to whatever this Task's Session was running. Null is
   * a request belonging to no running Task (a background process the agent left
   * going), and is dropped: it has no Audit Record to land on.
   */
  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  /** Whether this Task used the Reach, asked once and then forgotten. */
  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}
