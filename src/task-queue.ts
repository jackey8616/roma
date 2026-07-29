import { defaultConfig } from './config.js'

export interface TaskQueueOptions {
  /**
   * Tasks that may run at once across every Session. Defaults to the
   * configured cap.
   */
  readonly maxConcurrent?: number
}

/**
 * Told to a caller that has to wait, once, with the number of Tasks that were
 * ahead of it — 1 meaning nothing was.
 *
 * Awaited, and a rejection abandons the Task rather than running it anyway: a
 * caller who was never told it was waiting is a caller who believes nothing was
 * received, and that is the state the acknowledgement exists to prevent.
 */
export type WaitNotice = (position: number) => void | Promise<void>

interface Waiting {
  readonly key: string
  /**
   * Called once the slot has already been claimed on this Task's behalf, or
   * null while its caller is still being told it is waiting.
   *
   * A Task holds its place in the queue from the moment it arrives, so that the
   * position it is told is the position it has. Until the notice is delivered
   * there is nothing to admit it *into*, so admission steps over it — which is
   * why this is nullable rather than assigned late and hoped about.
   */
  admit: (() => void) | null
}

/**
 * Which Tasks are allowed to run right now.
 *
 * Two rules, and it exists because they are not the same rule. Tasks of one
 * Session are **serialised** — forced, not chosen, because two processes writing
 * one Session file corrupt it. And **three Tasks run at once** across all
 * Sessions, because the machine and the Shared Window are shared.
 *
 * One queue for the whole of roma, not one per Channel: the cap is global, so a
 * queue held per Core would quietly become three Tasks *per Channel*. It is
 * shared exactly the way the Session Pool is, and for the same reason.
 *
 * What it deliberately does not own is what a Task *is*. It takes a key and a
 * function, so nothing here knows about Sessions, Turns, or Conversations —
 * which is what keeps the ordering rules readable on their own.
 */
export class TaskQueue {
  readonly #maxConcurrent: number
  /**
   * The keys with a Task running. Its size is the number of running Tasks,
   * because a key never holds more than one.
   */
  readonly #busy = new Set<string>()
  /** In arrival order, which is the order admission considers them in. */
  readonly #waiting: Waiting[] = []

  constructor({ maxConcurrent = defaultConfig.maxConcurrentTasks }: TaskQueueOptions = {}) {
    if (maxConcurrent < 1) throw new Error('a Task queue must allow at least one Task at a time')
    this.#maxConcurrent = maxConcurrent
  }

  /** Tasks running right now. */
  get running(): number {
    return this.#busy.size
  }

  /** Tasks admitted to the queue and not yet started. */
  get waiting(): number {
    return this.#waiting.length
  }

  /**
   * Run one Task when its Session is free and a slot is available.
   *
   * `key` is what is serialised against — the Session id, in roma. Resolves or
   * rejects with whatever `task` did, and releases the slot either way: a Task
   * that failed is a Task that is over.
   *
   * `notice` is called only if the Task has to wait, before it joins the queue.
   */
  async run<T>(key: string, task: () => Promise<T>, notice?: WaitNotice): Promise<T> {
    if (!this.#claim(key)) {
      // The place in the queue is taken first and the caller told second. The
      // other way round, two Tasks arriving together would each be told they
      // were first, because neither is in the queue yet for the other to count.
      const entry: Waiting = { key, admit: null }
      this.#waiting.push(entry)
      try {
        await notice?.(this.#waiting.length)
      } catch (error) {
        this.#drop(entry)
        throw error
      }
      await new Promise<void>((admit) => {
        entry.admit = admit
        // A slot may have freed while the caller was being told, and nothing
        // else will come and look — admission stepped over this Task then,
        // and the release that freed the slot has already run.
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

  /** Take a slot for `key`, or report that there is not one to take. */
  #claim(key: string): boolean {
    if (this.#busy.size >= this.#maxConcurrent) return false
    if (this.#busy.has(key)) return false
    this.#busy.add(key)
    return true
  }

  /**
   * Start whatever the queue can now start.
   *
   * Arrival order, but a Task whose Session is busy is stepped over rather than
   * waited for. Strict head-of-line order would let one chatty Conversation hold
   * every other Conversation behind a Session that is simply not free yet.
   *
   * The slot is claimed here rather than by the Task itself, so that two
   * admissions in one pass cannot both take the last one.
   */
  #pump(): void {
    for (let i = 0; i < this.#waiting.length && this.#busy.size < this.#maxConcurrent; ) {
      const next = this.#waiting[i]
      if (next?.admit == null || !this.#claim(next.key)) {
        i += 1
        continue
      }
      this.#waiting.splice(i, 1)
      next.admit()
    }
  }

  /** Take a Task out of the queue without running it. */
  #drop(entry: Waiting): void {
    const at = this.#waiting.indexOf(entry)
    if (at !== -1) this.#waiting.splice(at, 1)
  }
}
