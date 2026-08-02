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

/**
 * What a caller can tell the queue about a Task beyond how to run it.
 *
 * Neither is needed to schedule anything, which is why they are together and
 * apart from the two arguments that are: `notice` is how the caller is told it
 * is waiting, and `taskId` is what `taskFor` answers with while it runs.
 */
export interface About {
  /** Called only if the Task has to wait, and only once. */
  readonly notice?: WaitNotice
  /**
   * Which Task this is, for `taskFor`.
   *
   * Optional because nothing about admission reads it. It is here so that
   * something outside the queue can ask whose work a Session is doing, which is
   * a question only the queue can answer honestly.
   */
  readonly taskId?: string
  /**
   * Serialise this against its key, but do not count it against the cap.
   *
   * For a free Relay (ADR-0012), and the two halves are answered differently
   * because they are different rules. Serialisation is forced — two processes
   * writing one Session file corrupt it, and a Relay needs that Session's
   * process like anything else — so a Relay queues behind the Session's work
   * and there is no way around it.
   *
   * The cap is a choice, and ADR-0003 argues it entirely in terms of model
   * work: retry storms holding a slot for three minutes, one bad credential
   * reaching "bot halted" on its own. A free Relay drives no Turn, spends nothing
   * and cannot storm. Counted, three people asking what is going on could stop
   * the work they are asking about.
   *
   * It does not let processes multiply either: what bounds those is the Session
   * Pool's `MAX_RESIDENT`, whatever this says.
   */
  readonly uncapped?: boolean
}

interface Waiting {
  readonly key: string
  /** What to record as running under this key once it is admitted. */
  readonly taskId: string | null
  /** Whether admitting this one is allowed to exceed the cap. */
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
   * Tasks running right now — what the cap counts, so free Relays are not in it.
   *
   * Derived rather than kept as a counter beside the map. The map holds at most
   * the cap plus however many free Relays are in flight, so counting it is free,
   * and a counter is one more thing that can drift out of step with the truth it
   * is describing.
   */
  get running(): number {
    return [...this.#busy.values()].filter((busy) => busy.capped).length
  }

  /** Tasks admitted to the queue and not yet started. */
  get waiting(): number {
    return this.#waiting.length
  }

  /**
   * Which Task is running under this key right now, or null.
   *
   * Null covers two different things on purpose, because the answer is the same
   * either way and inventing a distinction would invite somebody to act on it: a
   * key with nothing running, and a Task whose caller named none. What it must
   * never do is guess — a credential request that belongs to no running Task is
   * recorded as belonging to no Task rather than to the nearest one, which is the
   * same rule the Audit Record applies when it writes a Turn down as unpriced.
   */
  taskFor(key: string): string | null {
    return this.#busy.get(key)?.taskId ?? null
  }

  /**
   * Run one Task when its Session is free and a slot is available.
   *
   * `key` is what is serialised against — the Session id, in roma. Resolves or
   * rejects with whatever `task` did, and releases the slot either way: a Task
   * that failed is a Task that is over.
   *
   * Everything else is optional and goes in `about`, one object rather than a
   * row of positional maybes — a caller that wants only the second of them
   * should not have to write `undefined` for the first.
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

  /**
   * Take a slot for `key`, or report that there is not one to take.
   *
   * The serialisation check applies to everything and the cap check does not:
   * an uncapped entry still cannot join a key that is busy, because that rule is
   * about a file two processes must not both write.
   */
  #claim(key: string, taskId: string | null, capped: boolean): boolean {
    if (capped && this.running >= this.#maxConcurrent) return false
    if (this.#busy.has(key)) return false
    this.#busy.set(key, { taskId, capped })
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
   *
   * The whole list is walked rather than stopping once the cap is full: an
   * uncapped entry behind a full cap is still admissible, and a loop that
   * stopped there would hold every free Relay hostage to exactly the busy period
   * they exist to ask about. `#claim` is where the two rules are applied, so
   * this only has to stop deciding for it.
   */
  #pump(): void {
    for (let i = 0; i < this.#waiting.length; ) {
      const next = this.#waiting[i]
      if (next?.admit == null || !this.#claim(next.key, next.taskId, !next.uncapped)) {
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
