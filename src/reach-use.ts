export class ReachUse {
  readonly #tasks = new Set<string>()

  minted(taskId: string | null): void {
    if (taskId !== null) this.#tasks.add(taskId)
  }

  takeUsedBy(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }
}

export const GRANT_SETTLE_MS = 30_000

export interface GrantUseOptions {
  readonly settleMs?: number
  readonly wait?: (ms: number) => Promise<void>
}

export class GrantUse {
  readonly #tasks = new Map<string, string[]>()
  readonly #pending = new Map<string, Set<Promise<void>>>()
  readonly #settleMs: number
  readonly #wait: (ms: number) => Promise<void>

  constructor({
    settleMs = GRANT_SETTLE_MS,
    wait = (ms) => new Promise((done) => setTimeout(done, ms).unref()),
  }: GrantUseOptions = {}) {
    this.#settleMs = settleMs
    this.#wait = wait
  }

  begin(taskId: string): () => void {
    let finish: () => void = () => {}
    const finished = new Promise<void>((done) => {
      finish = done
    })
    const pending = this.#pending.get(taskId) ?? new Set<Promise<void>>()
    pending.add(finished)
    this.#pending.set(taskId, pending)
    return () => {
      finish()
      pending.delete(finished)
      if (pending.size === 0 && this.#pending.get(taskId) === pending) this.#pending.delete(taskId)
    }
  }

  async settled(taskId: string): Promise<void> {
    let late: Promise<'late'> | null = null
    for (;;) {
      const pending = this.#pending.get(taskId)
      if (pending === undefined || pending.size === 0) return
      late ??= this.#wait(this.#settleMs).then(() => 'late' as const)
      const outcome = await Promise.race([Promise.all(pending).then(() => 'done' as const), late])
      if (outcome === 'late') return
    }
  }

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
