import { defaultConfig } from './config.js'

export interface TaskQueueOptions {
  /** Tasks that may run at once across every Session. Defaults to the configured cap. */
  readonly maxConcurrent?: number
}

/**
 * Told to a caller that has to wait, once, with how many Tasks are waiting —
 * this one included, so 1 means it is the only one.
 *
 * A measure of the backlog, not a place in a running order: admission steps
 * over a Task whose Session is busy, so a later Task can overtake it.
 *
 * Awaited, and a rejection abandons the Task. A caller that would rather run
 * the Task anyway must absorb its own failure, as roma's Core does: a Channel
 * too broken to carry this is too broken to carry the failure either.
 */
export type WaitNotice = (position: number) => void | Promise<void>

/** What a caller can tell the queue about a Task beyond how to run it. All optional. */
export interface About {
  /** Called only if the Task has to wait, and only once. */
  readonly notice?: WaitNotice
  /** Which Task this is, for `taskFor`. Admission never reads it. */
  readonly taskId?: string
  /**
   * Serialise this against its key, but do not count it against the cap. For a
   * free Relay. It still queues behind its Session's work:
   * enforced by `fence:queue-relay-still-serialised`. It is not counted against
   * the cap: enforced by `fence:queue-free-relay-uncapped`.
   *
   * It does not bound processes: the Session Pool's `MAX_RESIDENT` does.
   */
  readonly uncapped?: boolean
}

interface Waiting {
  readonly key: string
  /** What to record as running under this key once it is admitted. */
  readonly taskId: string | null
  readonly uncapped: boolean
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
 * The Task Queue. It takes a key and a function and knows nothing about
 * Sessions, Turns or Conversations.
 *
 * One for the whole of roma. Enforced by `fence:queue-one-for-all-channels`.
 */
export class TaskQueue {
  readonly #maxConcurrent: number
  /**
   * The keys with something running, and what each one is running.
   *
   * Its size is **not** the number of running Tasks any more: a free Relay holds a
   * key without being one (ADR-0012). `running` counts what the cap counts, and
   * this counts what serialisation counts, which is everything.
   *
   * `taskId` is what makes `taskFor` possible, and it is null wherever a caller
   * did not name a Task. Kept here rather than anywhere else because this is the
   * only thing in roma that already knows a key has exactly one thing at a time —
   * that is the serialisation rule, and asking any other component would mean
   * building a second answer that could disagree with this one.
   */
  readonly #busy = new Map<string, { readonly taskId: string | null; readonly capped: boolean }>()
  /** In arrival order, which is the order admission considers them in. */
  readonly #waiting: Waiting[] = []

  constructor({ maxConcurrent = defaultConfig.maxConcurrentTasks }: TaskQueueOptions = {}) {
    if (maxConcurrent < 1) throw new Error('a Task queue must allow at least one Task at a time')
    this.#maxConcurrent = maxConcurrent
  }

  /**
   * Tasks running right now: what the cap counts, so free Relays are not in it.
   * Derived from the busy keys rather than kept as a counter that could drift.
   */
  get running(): number {
    return [...this.#busy.values()].filter((busy) => busy.capped).length
  }

  /** Tasks admitted to the queue and not yet started. */
  get waiting(): number {
    return this.#waiting.length
  }

  /**
   * Which Task is running under this key right now, or null: nothing is
   * running, or its caller named none. Never a guess.
   * Enforced by `fence:queue-task-for-never-guesses`.
   */
  taskFor(key: string): string | null {
    return this.#busy.get(key)?.taskId ?? null
  }

  /**
   * Run one Task when its key is free and a slot is available.
   *
   * `key` is what is serialised against — the Session id, in roma. Resolves or
   * rejects with whatever `task` did, and releases the slot either way.
   */
  async run<T>(key: string, task: () => Promise<T>, about: About = {}): Promise<T> {
    const { notice, taskId = null, uncapped = false } = about
    if (!this.#claim(key, taskId, !uncapped)) {
      // The place in the queue is taken first and the caller told second. The
      // other way round, two Tasks arriving together would each be told they
      // were first, because neither is in the queue yet for the other to count.
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

  /** Enforced by `fence:queue-relay-still-serialised`. */
  #claim(key: string, taskId: string | null, capped: boolean): boolean {
    if (capped && this.running >= this.#maxConcurrent) return false
    if (this.#busy.has(key)) return false
    this.#busy.set(key, { taskId, capped })
    return true
  }

  /** Enforced by `fence:queue-pump-steps-over-a-busy-session`, `fence:queue-pump-claims-the-slot` and `fence:queue-pump-walks-past-full-cap`. */
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
