import { defaultConfig } from './config.js'

export interface TaskQueueOptions {
  /**
   * Tasks that may run at once across every Session. Defaults to the
   * configured cap.
   */
  readonly maxConcurrent?: number
}

/**
 * Told to a caller that has to wait, once, with how many Tasks are waiting —
 * this one included, so 1 means it is the only one.
 *
 * A measure of the backlog rather than a place in a running order. Admission
 * steps over a Task whose Session is busy, so a Task told it is one of one can
 * still be overtaken by a Task that arrives later and is free to run. Nothing
 * schedules on this number; it exists so that waiting is not silent.
 *
 * Awaited, and a rejection abandons the Task rather than leaving it in a queue
 * it can never be admitted from. Whether failing to tell a caller is worth
 * abandoning its Task over is the caller's judgement, not the queue's — roma's
 * Core absorbs it and runs the Task regardless, on the grounds that a Channel
 * too broken to carry this is too broken to carry the failure either.
 */
export type WaitNotice = (position: number) => void | Promise<void>

interface Waiting {
  readonly key: string
  /**
   * Called once the slot has already been claimed on this Task's behalf, or
   * null while its caller is still being told it is waiting.
   *
   * A Task joins the queue the moment it arrives, so that the count it is told
   * includes everything already waiting. Until the notice has been delivered
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
   * `notice` is called only if the Task has to wait, and only once.
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
