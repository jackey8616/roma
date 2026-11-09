export class ReachUse {
  readonly #tasks = new Set<string>()

  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}
