import { defaultConfig } from './config.js'

export interface TaskQueueOptions {
  readonly maxConcurrent?: number
}

export type WaitNotice = (position: number) => void | Promise<void>

export interface About {
  readonly notice?: WaitNotice
  readonly taskId?: string
  readonly uncapped?: boolean
}

interface Waiting {
  readonly key: string
  readonly taskId: string | null
  readonly uncapped: boolean
  admit: (() => void) | null
}

export class TaskQueue {
  readonly #maxConcurrent: number
  readonly #busy = new Map<string, { readonly taskId: string | null; readonly capped: boolean }>()
  readonly #waiting: Waiting[] = []

  constructor({ maxConcurrent = defaultConfig.maxConcurrentTasks }: TaskQueueOptions = {}) {
    if (maxConcurrent < 1) throw new Error('a Task queue must allow at least one Task at a time')
    this.#maxConcurrent = maxConcurrent
  }

  get running(): number {
    return [...this.#busy.values()].filter((busy) => busy.capped).length
  }

  get waiting(): number {
    return this.#waiting.length
  }

  taskFor(key: string): string | null {
    return this.#busy.get(key)?.taskId ?? null
  }

  async run<T>(key: string, task: () => Promise<T>, about: About = {}): Promise<T> {
    const { notice, taskId = null, uncapped = false } = about
    if (!this.#claim(key, taskId, !uncapped)) {
      const entry: Waiting = { key, taskId, uncapped, admit: null }
      this.#waiting.push(entry)
      try {
        await notice?.(this.#waiting.length)
      } catch (error) {
        this.#drop(entry)
        throw error
      }
      await new Promise<void>((admit) => {
        entry.admit = admit
        this.#pump()
      })
    }

    try {
      return await task()
    } finally {
      this.#busy.delete(key)
      this.#pump()
    }
  }

  #claim(key: string, taskId: string | null, capped: boolean): boolean {
    if (capped && this.running >= this.#maxConcurrent) return false
    if (this.#busy.has(key)) return false
    this.#busy.set(key, { taskId, capped })
    return true
  }

  #pump(): void {
    for (let i = 0; i < this.#waiting.length;) {
      const next = this.#waiting[i]
      if (next?.admit == null || !this.#claim(next.key, next.taskId, !next.uncapped)) {
        i += 1
        continue
      }
      this.#waiting.splice(i, 1)
      next.admit()
    }
  }

  #drop(entry: Waiting): void {
    const at = this.#waiting.indexOf(entry)
    if (at !== -1) this.#waiting.splice(at, 1)
  }
}
