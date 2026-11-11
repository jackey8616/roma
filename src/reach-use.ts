export class ReachUse {
  readonly #tasks = new Set<string>()

  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}

export class GrantUse {
  readonly #tasks = new Map<string, string[]>()

  requested(taskId: string, grant: string): void {
    const grants = this.#tasks.get(taskId)
    if (grants === undefined) this.#tasks.set(taskId, [grant])
    else grants.push(grant)
  }

  takeRequestedBy(taskId: string): readonly string[] {
    const grants = this.#tasks.get(taskId) ?? []
    this.#tasks.delete(taskId)
    return grants
  }
}
