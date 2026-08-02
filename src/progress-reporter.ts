import type { TaskProgress } from './channel-adapter.js'
import {
  readCompacting,
  readTextDelta,
  readThinkingTokens,
  readToolFinished,
  readToolNames,
  readToolStarted,
  type ClaudeEvent,
} from './stream-events.js'

/**
 * How often an acknowledgement may be updated, at most.
 *
 * The floor of ADR-0003's 5–10 second range, because the measurement says the
 * floor costs nothing: with `--include-partial-messages` the longest a renderer
 * waited for new content during a 72-second generating Turn was 2641ms, so every
 * 5-second tick has something new to show and none of them is a wasted Channel
 * call. Slower would only make a live Task look less alive.
 */
const PROGRESS_INTERVAL_MS = 5_000

export interface ProgressReporterOptions {
  /**
   * Where an update goes.
   *
   * Best-effort by contract: a rejection is swallowed, because progress is the
   * one thing roma will go without. A Channel too broken to carry an update is
   * not a reason to abandon work that is running fine, and the result is still
   * owed to whoever asked for it.
   */
  readonly deliver: (progress: TaskProgress) => void | Promise<void>
  /**
   * Whether anything after the acknowledgement is sent at all.
   *
   * False for a Channel that cannot edit a message it has posted. The
   * acknowledgement still goes — it is a message, not an edit — and everything
   * after it is dropped rather than posted again.
   */
  readonly updates?: boolean
}

/**
 * One Task's acknowledgement, and the throttle that keeps it readable.
 *
 * The shape of the thing this exists for: a Task acknowledged the moment it
 * arrives, whose acknowledgement then keeps changing so that someone waiting can
 * tell it is alive rather than dead. The final result is not in here at all, and
 * that is the point — it is a separate message, unconditionally, and nothing
 * this class does can make it otherwise.
 *
 * Two jobs, because a stream that emits 194 events in 72 seconds cannot be shown
 * as it arrives. It reads events into a single "what is happening now", and it
 * sends that at most once per interval — the first one straight away, since an
 * acknowledgement nobody has seen yet is the one update that cannot wait.
 *
 * **There is no stall detection here and no timeout, deliberately.** Not because
 * silence is impossible — a tool window is 25 seconds of nothing, and tool
 * runtime is unbounded — but because that is exactly what makes a threshold
 * useless: a stalled tool call and a slow one are the same signal. A Task ends
 * when it finishes or when a human stops it. The older reason for this rule, that
 * generation itself is silent, is no longer true (#2) and should not be used to
 * argue the rule back the other way.
 */
export class ProgressReporter {
  readonly #deliver: (progress: TaskProgress) => void | Promise<void>
  readonly #updates: boolean

  /** What the Task is doing, as of the last event read. */
  #current: TaskProgress | null = null
  /** What the Channel was last told, and null until it has been told anything. */
  #sent: TaskProgress | null = null
  #sentAt = 0
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  /**
   * Deliveries, chained rather than concurrent.
   *
   * An Adapter posts the acknowledgement on the first instruction and edits it
   * on the rest, so two in flight at once is an edit racing the post it is
   * meant to be editing. Chaining costs nothing at one update per five seconds
   * and removes the race entirely.
   */
  #sending: Promise<void> = Promise.resolve()
  /**
   * How much the Turn has written so far, summed across its deltas.
   *
   * The length rather than the prose. Nothing downstream shows the answer as it
   * is written — ADR-0010 — so accumulating it would be holding a second copy of
   * a whole Turn's output (17706 characters, in the capture this was designed
   * against) for a reader that does not exist.
   */
  #characters = 0

  constructor({ deliver, updates = true }: ProgressReporterOptions) {
    this.#deliver = deliver
    this.#updates = updates
  }

  /**
   * Say what the Task is doing now.
   *
   * The first call is the acknowledgement and goes immediately; every one after
   * it is throttled, and a call that says what has already been sent is dropped
   * rather than sent again.
   */
  update(progress: TaskProgress): void {
    if (this.#stopped) return
    this.#current = progress
    if (this.#sent === null) {
      this.#send()
      return
    }
    if (!this.#updates) return
    this.#arm()
  }

  /** Read one stream event, and update if it says something new. */
  observe(event: ClaudeEvent): void {
    const progress = this.#read(event)
    if (progress !== null) this.update(progress)
  }

  /**
   * The Task is over: nothing more is scheduled, and nothing more is sent.
   *
   * Deliberately waits on nothing. An update the Channel has not finished
   * taking would otherwise hold the result back, and a `deliver` that never
   * settles would hold it back forever — which would turn the one instruction
   * roma will go without into the one that can silence a Task.
   *
   * But not waiting is not the same as letting go. An update already queued
   * behind one the Channel is still taking is dropped here rather than handed
   * over late: the acknowledgement is finished with the moment the result is
   * posted, and an Adapter is entitled to act on that — the one roma has drops
   * the message it was editing, so a late update has nothing to edit and posts
   * a new one. A stale "Working…" underneath the answer, on the Channel that is
   * slow enough to have caused it.
   *
   * This is where that has to be decided. Left to the Adapters it is a rule
   * every Channel has to be told, and the first one was written without knowing
   * it: `channel-adapter.ts` states the guarantee this keeps.
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * What one event says the Task is doing, or null if it says nothing about it.
   *
   * Arrival order decides, with no precedence between phases: the stream is
   * already sequential, and a Turn that thinks, calls a tool and then writes
   * says so in that order.
   */
  #read(event: ClaudeEvent): TaskProgress | null {
    const text = readTextDelta(event)
    if (text !== '') {
      this.#characters += text.length
      return { phase: 'writing', characters: this.#characters }
    }
    const estimatedTokens = readThinkingTokens(event)
    if (estimatedTokens !== null) return { phase: 'thinking', estimatedTokens }
    const started = readToolStarted(event)
    if (started !== null) return { phase: 'tool', tool: started }
    // The other dead stream, and the longer one. Nothing arrives between this and
    // the boundary — 28,517ms in the longest capture — so without it a `/compact`
    // posts "Working…" and then says nothing at all for half a minute.
    if (readCompacting(event)) return { phase: 'compacting' }
    // Only where a tool is what is being shown. A background task finishing
    // while the answer is being written closes no window the acknowledgement is
    // showing, and would otherwise throw the prose away for a whole interval.
    if (readToolFinished(event)) {
      return this.#current?.phase === 'tool' ? { phase: 'working' } : null
    }
    const tools = readToolNames(event)
    if (tools.length > 0) return { phase: 'tool', tool: tools.join(', ') }
    return null
  }

  /** Send at the next moment the throttle allows, which may be now. */
  #arm(): void {
    if (this.#timer !== null) return
    const dueIn = this.#sentAt + PROGRESS_INTERVAL_MS - Date.now()
    if (dueIn <= 0) {
      this.#tick()
      return
    }
    const timer = setTimeout(() => {
      this.#timer = null
      this.#tick()
    }, dueIn)
    timer.unref?.()
    this.#timer = timer
  }

  /**
   * The interval has come round. Send whatever the Task is doing *now*, not
   * whatever armed the timer — a burst of 194 events becomes one update.
   *
   * Nothing is rearmed here. A Task that has gone quiet has nothing to send, and
   * the next thing that does happen arms the timer again from `update`.
   */
  #tick(): void {
    if (this.#stopped || this.#current === null) return
    if (saysTheSame(this.#current, this.#sent)) return
    this.#send()
  }

  #send(): void {
    const progress = this.#current
    if (progress === null) return
    this.#sent = progress
    this.#sentAt = Date.now()
    this.#sending = this.#sending.then(async () => {
      // Queued while the Channel was taking the one before it, and the Task has
      // ended since. `update` turns new callers away once stopped; this is the
      // same rule for the ones that were already on the chain.
      if (this.#stopped) return
      try {
        await this.#deliver(progress)
      } catch {
        // Best-effort by contract. Nothing to do with it: there is no second
        // Channel to tell, and a Task that is running fine has no failure to
        // report yet.
      }
    })
  }
}

/**
 * Whether two states say the same thing.
 *
 * What keeps a tool window quiet. Twenty-five seconds of a tool running is five
 * ticks of the throttle with nothing new to show, and editing a message to
 * exactly what it already says is five wasted Channel calls.
 */
function saysTheSame(a: TaskProgress, b: TaskProgress | null): boolean {
  if (b === null) return false
  switch (a.phase) {
    case 'queued':
      return b.phase === 'queued' && b.position === a.position
    case 'working':
      return b.phase === 'working'
    case 'compacting':
      // No number to compare, and none is wanted: a Compaction reports nothing
      // while it runs, so every moment of one really does say the same thing.
      return b.phase === 'compacting'
    case 'thinking':
      return b.phase === 'thinking' && b.estimatedTokens === a.estimatedTokens
    case 'tool':
      return b.phase === 'tool' && b.tool === a.tool
    case 'writing':
      // Why `writing` carries a number at all. Compared on the phase alone,
      // every moment of a generating Turn would say the same thing as the last
      // and the Acknowledgement would sit still for all 72 seconds of it.
      return b.phase === 'writing' && b.characters === a.characters
  }
}
