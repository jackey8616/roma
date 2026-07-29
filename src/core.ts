import { randomUUID } from 'node:crypto'
import { monthOf, type AuditLog, type TaskOutcome } from './audit-log.js'
import type { CredentialKind } from './build-env.js'
import type { ChannelAdapter, IngressMessage, OutboundInstruction } from './channel-adapter.js'
import { TurnFailedError, wasInterrupted, type Turn } from './claude-session.js'
import { readCommand, type Command } from './commands.js'
import { ProgressReporter } from './progress-reporter.js'
import type { SessionGenerations } from './session-generation.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { overflowOffer, readQuota, spentUntil, type Quota } from './quota.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import { readSystemInit, type ClaudeEvent } from './stream-events.js'
import type { TaskQueue } from './task-queue.js'

/**
 * Metered billing, and the ceiling on it. Absent means roma has no Overflow at
 * all, which is what a deployment with no metered key has.
 */
export interface OverflowOptions {
  /**
   * What Overflow may cost in one calendar month before it is refused outright.
   *
   * Named by the deployment rather than defaulted, for the reason `auditRoot`
   * is: this is a number somebody has to have decided, and a default would be
   * roma deciding how much of their money to spend on their behalf. Without a
   * cap, ADR-0002's "off by default" is ceremony rather than protection.
   */
  readonly monthlyCapUsd: number
}

/** One thing the Core did that an operator, rather than a Conversation, needs. */
export type CoreLogRecord = {
  /**
   * Overflow was asked for and the monthly cap refused it.
   *
   * How the owner finds out, and the only place the numbers behind the refusal
   * are written down: the person who asked is told they were refused, but a
   * month that has spent its budget is not theirs to act on.
   */
  readonly event: 'overflow-refused'
  readonly taskId: string
  readonly month: string
  readonly capUsd: number
  readonly spentUsd: number
  /**
   * How much of that month's total is a floor rather than a figure — Tasks
   * nothing priced, and records that could not be read. Above zero, roma refused
   * on a number it knows to be an understatement.
   */
  readonly unpriced: number
  readonly unreadable: number
}

export type CoreLog = OperatorLog<CoreLogRecord>

export interface CoreOptions {
  /**
   * Where this Core's messages come from and go back to.
   *
   * One Core per Channel, sharing one pool. That is what keeps the Core free of
   * Channel identity: there is no routing table to consult and no field to
   * inspect, because a Core only ever has one place to reply to. (Two Channels
   * that mint the same Conversation Key would share a Session — ADR-0003 leaves
   * whether that is allowed undecided, and nothing here depends on it.)
   */
  readonly channel: ChannelAdapter
  readonly pool: SessionPool
  /**
   * Shared with every other Core, exactly as the pool is.
   *
   * Required rather than defaulted, because a queue each Core made for itself
   * would still work and would still be wrong: the cap is three Tasks across
   * the whole of roma, and one queue per Channel silently makes it three per
   * Channel.
   */
  readonly queue: TaskQueue
  /**
   * Which Session each Conversation is on — only a question because `/new` can
   * move one.
   *
   * Shared with every other Core over the same working directories, for the
   * reason the pool and the queue are: a Conversation two Cores each kept their
   * own answer for would be two Conversations, one of which never heard about
   * the `/new`.
   */
  readonly sessions: SessionGenerations
  /**
   * Where every Task is written down, and shared like everything else here.
   *
   * Required rather than optional, though an optional one would be easy: a Core
   * built without it would run perfectly and quietly produce nothing, and what
   * it produces nothing of is the only record of who spent what. Per-user
   * attribution does not exist at the provider (ADR-0002), so an audit log that
   * was accidentally left out cannot be reconstructed afterwards from anywhere.
   */
  readonly audit: AuditLog
  /**
   * Which credential the Tasks this Core runs are paid for by.
   *
   * Per Core today because it is per process: every Session in the pool is
   * spawned from one environment built from one credential. Overflow will make
   * it a per-Task decision, at which point this moves onto the Task — the field
   * on the record is already per-Task, which is what makes that a change of
   * where the value comes from rather than a change of what is recorded.
   */
  readonly credential: CredentialKind
  /** Metered billing. Omitted, Overflow is never offered and never taken. */
  readonly overflow?: OverflowOptions
  readonly log?: CoreLog
}

/**
 * How a parked Task came to be running again, or not.
 *
 * A blocked Task waits for exactly three things and there is no fourth: the
 * window comes back, somebody buys their way past it, or somebody gives up.
 */
type Resumption = 'reset' | 'overflow' | 'stopped'

/**
 * One Task this Core is in the middle of, as `/stop` needs to see it.
 *
 * Kept because neither of the other two places knows enough on its own. The
 * pool knows which Sessions have a Turn in flight, but not which Conversation
 * asked for one, and not about a Task whose process is still starting; the
 * queue knows what is waiting, but only as opaque keys. This is the Core's own
 * record of the work it has taken on, and it is what makes `/stop` mean "the
 * work I asked for" rather than "whatever is running in the Session I am on
 * now".
 */
interface RunningTask {
  readonly conversationKey: string
  /**
   * The Session it is on, which is not always the one its Conversation is on: a
   * `/new` in between moves the Conversation and leaves the Task where it
   * started.
   */
  readonly sessionId: string
  /** Set by `/stop`, and read at each point the Task can still be stopped. */
  stopped: boolean
  /**
   * What Claude Code said its credential resolved to while serving this Task,
   * off the `system/init` its Turn began with. Null until one arrives, and for a
   * Task whose Turn never began.
   */
  apiKeySource: string | null
  /**
   * Whether Claude Code was ever given this Task's message.
   *
   * What separates a Task that spent nothing from one that spent something
   * nobody can name. A Task stopped in the queue never sent a message and is
   * free with certainty; one whose process died mid-Turn had already spent
   * whatever it had spent, and the cost only ever arrives on a terminal event
   * that is not coming.
   */
  turnBegan: boolean
  /** Its own id, so an offer taken later can name the Task it belongs to. */
  readonly taskId: string
  /**
   * Which credential the next attempt is to be paid for by.
   *
   * On the Task rather than on the Core because Overflow is a decision made
   * about one Task while it is already running — and it moves back for the
   * Conversation's next message, which is the persistent toggle ADR-0002
   * refuses not being arrived at by accident.
   */
  credential: CredentialKind
  /** What the stream last said about the Shared Window while serving this Task. */
  quota: Quota | null
  /**
   * How to wake this Task where it is parked waiting for the window, or null
   * when it is not parked.
   *
   * The Task is doing nothing at all while this is set: it holds no concurrency
   * slot and no process, which is what makes waiting three hours for a reset
   * something roma can afford to do at all.
   */
  wake: ((resumption: Resumption) => void) | null
  /** Set while an offer of Overflow is outstanding on this Task, and only then. */
  offered: boolean
  /** The timer waiting out the window, while this Task is parked against one. */
  parked: NodeJS.Timeout | null
}

/**
 * What a Task spent, accumulated over however many attempts it took.
 *
 * `costUsd` is the sum of the attempts anything priced, and null only where
 * nothing priced any of them — so it is a floor rather than a claim, which is
 * the same promise the Audit Record makes about it. `turnMs` is the last
 * attempt's, because it answers "how long was Claude Code working on the answer
 * you got" and the attempt the window refused produced no answer.
 */
interface Spend {
  readonly costUsd: number | null
  readonly turnMs: number | null
}

/**
 * roma with the Channel taken out: a message goes in, outbound instructions
 * come out.
 *
 * Everything hard is on the other side of it — Session lifetime, resume,
 * eviction, serialisation, cost — and none of it has any idea which product the
 * message came from. That is the point of the split rather than a side effect of
 * it: a second Channel is an Adapter, not a rewrite, and the only thing keeping
 * that true is that nothing in here can name one.
 *
 * A Task ends one of two ways, and both of them are something the Conversation
 * is told: the result of the Turn, or why there isn't one. Silence is not an
 * outcome the Core has — someone waiting on a Task that died is the failure this
 * exists to prevent.
 */
export class Core {
  readonly #channel: ChannelAdapter
  readonly #pool: SessionPool
  readonly #queue: TaskQueue
  readonly #sessions: SessionGenerations
  readonly #audit: AuditLog
  readonly #credential: CredentialKind
  readonly #overflow: OverflowOptions | null
  readonly #log: CoreLog
  /**
   * The Tasks this Core has taken on and not yet answered — queued ones
   * included, since a Task that has not started is still one a person can stop.
   *
   * A set rather than an index by Conversation: it holds at most the three Tasks
   * running plus whatever is waiting, so finding a Conversation's own is a walk
   * over a handful of entries, and there is no map of empty sets to prune.
   */
  readonly #running = new Set<RunningTask>()

  constructor({
    channel,
    pool,
    queue,
    sessions,
    audit,
    credential,
    overflow,
    log,
  }: CoreOptions) {
    if (!channel.capabilities.stableConversationKey) {
      // No Adapter should ever declare this false: a Channel without a stable key
      // of its own mints and persists one inside its Adapter, so the key is
      // stable by the time the Core sees it. Which is exactly why the
      // declaration is worth reading — the Core derives ids and stores nothing,
      // so it has nowhere to make an unstable key stable, and an Adapter that
      // says it cannot supply one is describing a bug. Better as a refusal here
      // than as Conversations that quietly forget everything they were told.
      throw new Error('a Channel must supply a stable Conversation Key')
    }
    this.#channel = channel
    this.#pool = pool
    this.#queue = queue
    this.#sessions = sessions
    this.#audit = audit
    this.#credential = credential
    this.#overflow = overflow ?? null
    this.#log = log ?? writeToStderr
  }

  /**
   * Take one message: a Command roma answers itself, or a Task.
   *
   * The two are told apart here rather than in an Adapter, so that `/stop` means
   * the same thing on every Channel and a Channel cannot invent a third
   * Command. Everything that is not one of the two is work, including every
   * slash command Claude Code has of its own.
   *
   * Resolves when the Conversation has been told how it went. It rejects only
   * if the Channel could not be told at all — a failed Task is an outcome, not
   * an error, and reporting it is how this method succeeds.
   */
  async handle(message: IngressMessage): Promise<void> {
    const command = readCommand(message.text)
    if (command !== null) return await this.#runCommand(command, message)
    return await this.#runTask(message)
  }

  /**
   * Carry out a Command and say what it did.
   *
   * Outside the Task queue, which is not an optimisation: a Command that queued
   * would be serialised against its own Conversation, so `/stop` would wait for
   * the Task it was sent to stop and arrive after it had finished. It also
   * takes no concurrency slot — a Command drives no Turn, so counting it against
   * the three Tasks roma runs at once would let people asking it to stop things
   * crowd out the work.
   *
   * A Command produces one instruction and no acknowledgement. There is nothing
   * to acknowledge: it is over by the time the Conversation could be told it had
   * begun.
   */
  async #runCommand(command: Command, { conversationKey }: IngressMessage): Promise<void> {
    // Not a Task, and it still gets an id — see `TaskAddress` for why.
    const taskId = randomUUID()

    let instruction: OutboundInstruction
    try {
      const carriedOut = this.#carryOut(command, conversationKey)
      instruction = { kind: 'command-outcome', taskId, conversationKey, command, carriedOut }
    } catch {
      // Silence is not an outcome here either. Nothing routine reaches this —
      // it takes a generation record roma cannot read, or a Conversation Key an
      // Adapter emptied — and either way the person is owed the difference
      // between a Command that did nothing because there was nothing to do and
      // one that did nothing because roma is broken.
      instruction = { kind: 'failure', taskId, conversationKey, reason: ROMA_FAILED_COMMAND }
    }

    await this.#channel.deliver(instruction)
  }

  /** Do what the Command asks, and say whether there was anything to do. */
  #carryOut(command: Command, conversationKey: string): boolean {
    if (command === 'new') {
      // Nothing is torn down. `/new` is aimed at what the *next* message
      // reaches: a Task already running in the old Session finishes and still
      // answers the person who asked, and the process behind it is left to the
      // pool, which reaps or evicts it like any other Session nobody is talking
      // to any more. Always true — a Conversation can always be given a Session
      // with nothing in it, including one that has never had a Session at all.
      this.#sessions.freshSession(conversationKey)
      return true
    }
    return this.#stop(conversationKey)
  }

  /**
   * End this Conversation's work, and say whether there was any.
   *
   * Aimed at the Tasks roma is actually in the middle of rather than at the
   * Session the Conversation is on now, because those are not always the same
   * Session: a `/new` between the message and the `/stop` moves the Conversation
   * on while the work it was asked to stop carries on where it started. Asking
   * the generation would answer about an empty Session and leave the Task
   * running with the person told there was nothing to stop.
   *
   * A Task is stopped whether or not it has reached Claude Code yet. Between
   * arriving and its first token a Task can be queued behind three others and
   * then waiting on a cold start, which is minutes in which it is visibly
   * running, `/stop` is exactly what a person would send, and there is no Turn
   * to interrupt. Marking it is what covers that window: a Task stopped before
   * it starts never starts, and one stopped while its process is still coming up
   * is interrupted the moment its Turn begins.
   */
  #stop(conversationKey: string): boolean {
    const mine = [...this.#running].filter((task) => task.conversationKey === conversationKey)
    for (const task of mine) {
      task.stopped = true
      // A Task waiting out a spent window has no Turn to interrupt and no slot
      // to give back; what it has is a wait that would otherwise run for hours
      // after somebody said to stop.
      this.#wake(task, 'stopped')
      this.#pool.interrupt(task.sessionId)
    }
    return mine.length > 0
  }

  /**
   * Run one Task: the message in, the Turn it drives, the outcome back out.
   *
   * The Task is acknowledged before it has produced anything, and that
   * acknowledgement keeps changing while it runs, so nobody is left guessing
   * whether it is alive. It waits its turn first — its Session may already be
   * busy, since two messages in one Conversation are handled one at a time
   * because two processes writing one Session file corrupt it, or roma may
   * already be running as much as it runs at once — and waiting is a thing the
   * acknowledgement says rather than a silence.
   */
  async #runTask(message: IngressMessage): Promise<void> {
    const { conversationKey } = message
    // Minted here rather than derived, because it names this Task and not the
    // Conversation: two messages in one Conversation can be in flight at once,
    // each with an acknowledgement of its own for the Adapter to keep up to
    // date.
    const taskId = randomUUID()
    // From arrival rather than from admission: queueing and cold start are time
    // the person spent waiting, and a Task stopped before it started has no
    // other duration at all.
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      // The Adapter is told whether it may edit; the Core is what obeys the
      // answer. Where it cannot, the acknowledgement is sent once and nothing
      // follows it.
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) =>
        this.#channel.deliver({ kind: 'progress', taskId, conversationKey, progress }),
    })

    let instruction: OutboundInstruction
    let running: RunningTask | null = null
    let spend: Spend = { costUsd: null, turnMs: null }
    try {
      // No lookup and nothing to have gone stale: the Conversation Key is the
      // Session id, one hash apart. The one thing read is which generation of it
      // `/new` has left the Conversation on, and a Conversation that has never
      // used `/new` is on the first. Read on arrival rather than on admission,
      // so that a message already waiting in the queue when a `/new` lands still
      // goes to the Session it was sent to — and read inside the try, because a
      // Conversation roma cannot work out the Session for is one that would
      // otherwise be answered with silence.
      const sessionId = this.#sessions.sessionFor(conversationKey)
      // Known from here on rather than from the first token, so that `/stop`
      // reaches a Task that is queued or still starting its process.
      const task: RunningTask = {
        taskId,
        conversationKey,
        sessionId,
        stopped: false,
        apiKeySource: null,
        turnBegan: false,
        credential: this.#credential,
        quota: null,
        wake: null,
        offered: false,
        parked: null,
      }
      running = task
      this.#running.add(task)

      const driven = await this.#drive(task, message.text, reporter)
      instruction = driven.instruction
      spend = driven.spend
    } catch (error) {
      // Reached only where roma could not work out which Session the Conversation
      // is on, since everything after that is an ending `#drive` describes.
      instruction = { kind: 'failure', taskId, conversationKey, reason: reasonFor(error) }
    } finally {
      if (running !== null) this.#running.delete(running)
    }

    // Written before the Channel is told, because the two obligations are
    // different and only one of them is anybody's to try again. An instruction
    // the Channel refuses is reported to whoever handed the message in; a record
    // dropped because the Channel was down would be a Task that spent money and
    // left no trace of who spent it, and nothing later can reconstruct it. This
    // cannot throw — see `AuditLog.record` — so it also cannot silence a Task.
    this.#audit.record({
      taskId,
      caller: message.caller,
      // Null only where the Task failed before roma could work out which Session
      // it belonged to, which is the one failure that happens before it has one.
      sessionId: running?.sessionId ?? null,
      // Read off the instruction rather than tracked alongside it, so the record
      // and the Conversation cannot end up telling different stories.
      outcome: outcomeOf(instruction),
      costUsd: spend.costUsd,
      durationMs: Date.now() - startedAt,
      turnMs: spend.turnMs,
      // The credential the Task ended on, which is the one that paid for the
      // answer: a Task blocked on the Shared Window and rerun on Overflow is
      // Overflow's, and the attempt the window refused bought nothing to bill.
      credential: running?.credential ?? this.#credential,
      apiKeySource: running?.apiKeySource ?? null,
    })

    // Nothing more is scheduled, and nothing in flight is waited on: an update
    // the Channel has not finished taking is not a reason to hold back the one
    // message roma owes unconditionally.
    reporter.stop()
    await this.#channel.deliver(instruction)
  }

  /**
   * Take a Task as far as an ending, however many attempts that takes.
   *
   * More than one only when the Shared Window is spent. A blocked Task is not
   * over: ADR-0002 has roma say so, quote the reset time, and keep the Task —
   * so it waits, holding no concurrency slot and no process, and runs again when
   * the window comes back or when somebody takes Overflow.
   *
   * There is no limit on how many times that can happen, and deliberately none.
   * The state ADR-0003 lists under accepted risks is Tasks holding slots, and a
   * parked Task holds nothing; every park is announced, and `/stop` reaches it
   * throughout. A Task that waits out two windows is somebody's to abandon, not
   * roma's.
   */
  async #drive(
    task: RunningTask,
    text: string,
    reporter: ProgressReporter,
  ): Promise<{ instruction: OutboundInstruction; spend: Spend }> {
    const { taskId, conversationKey } = task
    let spend: Spend = { costUsd: null, turnMs: null }

    for (;;) {
      let turn: Turn | null = null
      let error: unknown = null
      try {
        turn = await this.#queue.run(
          task.sessionId,
          () => this.#runTurn(task, text, reporter),
          // The one thing roma will go without, and it is the reporter that
          // absorbs the failure: a Channel too broken to carry this is too broken
          // to carry the failure that abandoning the Task would produce, so
          // refusing to run it buys no less silence — it only adds losing the
          // work to it.
          (position) => reporter.update({ phase: 'queued', position }),
        )
      } catch (thrown) {
        error = thrown
        // A Turn that failed reports its own cost, and a Task that cost money
        // must be recorded whether or not it produced anything.
        if (thrown instanceof TurnFailedError) turn = thrown.turn
      }

      // Every attempt, because a Task that was blocked and then ran was billed
      // for whatever each of them managed to spend before it ended.
      spend = add(spend, turn, task)

      if (error === null && turn !== null) {
        return {
          instruction: {
            kind: 'result',
            taskId,
            conversationKey,
            text: turn.text,
            // Only where somebody chose to spend money, which is the one case
            // ADR-0002 requires a figure in the reply.
            ...(task.credential === 'overflow' ? { overflowCostUsd: spend.costUsd } : {}),
          },
          spend,
        }
      }

      // Parked rather than ended, if the window is what stopped it and nobody
      // has said to stop waiting.
      if (!task.stopped && (await this.#park(task))) continue

      return {
        // `task.stopped` as well as the Turn's own ending, because a Task
        // stopped while it was parked has a Turn that failed for whatever the
        // window did to it — reported as a failure, that reads as roma breaking
        // rather than as the thing somebody just asked for.
        instruction:
          task.stopped || wasStopped(error)
            ? { kind: 'stopped', taskId, conversationKey }
            : { kind: 'failure', taskId, conversationKey, reason: reasonFor(error) },
        spend,
      }
    }
  }

  /**
   * Hold a Task the Shared Window has blocked, and say whether to run it again.
   *
   * False where the Turn failed for any other reason, or where the event will
   * not say when the window comes back: a Task parked against a moment that
   * never arrives waits for ever, and nothing else in roma would come and look
   * at it. Better a Task that fails and can be sent again.
   *
   * The Conversation is told before the waiting starts, and told best-effort —
   * the same judgement the acknowledgement gets. A Channel that cannot take this
   * message leaves somebody waiting without an explanation, which is worse than
   * silence for a moment and much better than losing the work.
   */
  async #park(task: RunningTask): Promise<boolean> {
    const quota = task.quota
    const resetsAt = quota === null ? null : spentUntil(quota)
    if (quota === null || resetsAt === null) return false

    // Offered on what the provider says, not on what roma would like: a valve
    // the account cannot use is a button that spends somebody's attention and
    // then fails, at the moment they are already waiting.
    task.offered = this.#overflow !== null && overflowOffer(quota)
    await this.#tell({
      kind: 'blocked',
      taskId: task.taskId,
      conversationKey: task.conversationKey,
      resetsAt,
      overflowOffered: task.offered,
    })

    const resumption = await new Promise<Resumption>((wake) => {
      task.wake = wake
      // Clamped, because a reset already in the past is a clock that disagrees
      // with the provider's rather than a Task that should wait a negative time.
      const timer = setTimeout(() => this.#wake(task, 'reset'), Math.max(0, resetsAt * 1000 - Date.now()))
      timer.unref?.()
      task.parked = timer
    })
    this.#unpark(task)

    // Stopped while it waited. The acknowledgement goes back to saying the Task
    // is running on the next attempt, which `#runTurn` does for itself.
    return resumption !== 'stopped'
  }

  /**
   * Take the offer of Overflow on one Task, and say whether there was one.
   *
   * A method rather than a third Command. ADR-0003 has exactly two, recognised
   * only when the whole message is one of them, and a `/overflow` anybody could
   * type at any moment would have to answer for itself when nothing is blocked.
   * This is an answer to a specific offer roma made about a specific Task, so it
   * is named by that Task's id — which the Adapter already has, on the
   * instruction that carried the offer.
   *
   * False where there is nothing to take: the window came back first, somebody
   * stopped the Task, or the id is not one roma is holding. An Adapter says so
   * in its own words; roma has no message for it, because nothing happened.
   *
   * Anyone may take it. ADR-0002 is explicit that restricting it to an admin
   * turns a person into an approval queue and strands urgent work whenever they
   * are offline, so there is nobody to check here and no check to make.
   */
  async takeOverflow(taskId: string): Promise<boolean> {
    const task = [...this.#running].find(
      (candidate) => candidate.taskId === taskId && candidate.offered && candidate.wake !== null,
    )
    if (task === undefined || this.#overflow === null) return false

    const refusal = this.#capRefusal(this.#overflow, taskId)
    if (refusal !== null) {
      // The Task stays parked. Refused is not abandoned — the window still comes
      // back, and this is still the Task that was blocked.
      await this.#tell({
        kind: 'overflow-refused',
        taskId,
        conversationKey: task.conversationKey,
        capUsd: refusal.capUsd,
        spentUsd: refusal.spentUsd,
      })
      return true
    }

    task.credential = 'overflow'
    this.#wake(task, 'overflow')
    return true
  }

  /**
   * Why the monthly cap refuses this, or null if it does not.
   *
   * Measured on the Audit Records' per-Turn costs, which is the whole of #9's
   * argument arriving here: totalled from cumulative Session figures instead,
   * this cap would refuse spending that never happened, and the more a Session
   * was used the sooner.
   *
   * The comparison is against `costUsd`, which the audit log is explicit is a
   * floor — Tasks nothing priced are not in it, and neither are records that
   * could not be read. Erring towards allowing rather than refusing, because a
   * cap that refused on every torn line would close Overflow for the rest of the
   * month over one power loss. Both counts go into the record below, so the
   * refusal an operator reads says how solid the number behind it was.
   */
  #capRefusal(
    overflow: OverflowOptions,
    taskId: string,
  ): { capUsd: number; spentUsd: number } | null {
    const month = monthOf(new Date())
    const total = this.#audit.totalFor(month, 'overflow')
    if (total.costUsd < overflow.monthlyCapUsd) return null

    this.#log({
      event: 'overflow-refused',
      taskId,
      month,
      capUsd: overflow.monthlyCapUsd,
      spentUsd: total.costUsd,
      unpriced: total.unpriced,
      unreadable: total.unreadable,
    })
    return { capUsd: overflow.monthlyCapUsd, spentUsd: total.costUsd }
  }

  /** Wake a parked Task, if it is still parked. */
  #wake(task: RunningTask, resumption: Resumption): void {
    const wake = task.wake
    if (wake === null) return
    this.#unpark(task)
    wake(resumption)
  }

  /** Stop holding a Task, whichever way its wait ended. */
  #unpark(task: RunningTask): void {
    if (task.parked !== null) clearTimeout(task.parked)
    task.parked = null
    task.wake = null
    task.offered = false
  }

  /**
   * Tell the Channel something the Task's ending does not depend on.
   *
   * Absorbed rather than propagated, the same as progress: these are messages
   * about a Task that is still going, and a Channel that cannot take one is not
   * a reason to throw away work that will still produce an answer. The result
   * and the failure are the two that are never absorbed.
   */
  async #tell(instruction: OutboundInstruction): Promise<void> {
    try {
      await this.#channel.deliver(instruction)
    } catch {
      // Nothing to do with it. The Task carries on, and its ending is delivered
      // on its own terms.
    }
  }

  /**
   * Drive the Turn, reporting on it as the stream says what it is doing.
   *
   * The acknowledgement goes out here rather than on arrival, so that a Task
   * that had to wait says it was waiting first and only then says it is
   * running. Both are the same message; this is the second thing it says.
   *
   * Filtered by Session id because the pool is shared by every Core, so its
   * events are every Conversation's. The listeners are a Turn's worth long: one
   * Task, one subscription each, dropped in the `finally` whichever way the Turn
   * ended.
   */
  async #runTurn(task: RunningTask, text: string, reporter: ProgressReporter): Promise<Turn> {
    // Stopped while it waited its turn. Starting it now would spend a Turn on
    // work somebody has already said they do not want, and then interrupt it.
    if (task.stopped) throw new TaskStopped()

    const { sessionId } = task
    reporter.update({ phase: 'working' })
    const onEvent = (id: string, event: ClaudeEvent): void => {
      if (id !== sessionId) return
      // The audit record's other half: which credential Claude Code itself says
      // is paying, rather than which one roma believes it handed over. One
      // arrives at the start of every Turn, so this is this Turn's own answer.
      const init = readSystemInit(event)
      if (init !== null) task.apiKeySource = init.apiKeySource
      // One of these arrives on every Turn. Kept rather than acted on here: what
      // it means for a Turn that then failed is `#park`'s judgement, and reading
      // it in two places is how the two would come to disagree.
      const quota = readQuota(event)
      if (quota !== null) task.quota = quota
      reporter.observe(event)
    }
    // The window a `/stop` cannot act on by itself: from here until Claude Code
    // has the message, there is no Turn to interrupt, and a cold start makes
    // that seconds rather than an instant. The Turn beginning is the first
    // moment the request can land, so it is sent then.
    const onTurnStart = (id: string): void => {
      if (id !== sessionId) return
      // Also the moment this Task stops being free with certainty: from here it
      // has spent whatever it has spent, whether or not anything ever reports it.
      task.turnBegan = true
      if (task.stopped) this.#pool.interrupt(sessionId)
    }
    this.#pool.on('event', onEvent)
    this.#pool.on('turn-start', onTurnStart)
    try {
      return await this.#pool.send(sessionId, text, task.credential)
    } finally {
      this.#pool.off('event', onEvent)
      this.#pool.off('turn-start', onTurnStart)
    }
  }
}

/**
 * What roma says about a Task that failed on roma's side rather than in the Turn.
 *
 * Deliberately plain and deliberately fixed. The alternative is forwarding the
 * error's own message, and those are written for whoever is reading the code:
 * "claude exited mid-Turn (code=1, signal=null)", or a Session uuid the person
 * in the Conversation has never seen and cannot act on. What a Conversation
 * needs from this is that the Task is dead, so that nobody waits on it. The
 * detail is an operator's, and the pool already writes the process's side of it
 * — an `exit` record with the code and the signal — where operators look.
 */
const ROMA_FAILED = 'roma could not run this Task.'

/**
 * The same, for a Command.
 *
 * Its own sentence because "Task" is the wrong word for `/stop`, and because
 * what the person does next differs: a Task can be sent again, and a Command
 * that roma could not carry out will fail the same way until somebody looks at
 * it.
 */
const ROMA_FAILED_COMMAND = 'roma could not carry out that command.'

/**
 * A Task that was stopped before it ever reached Claude Code.
 *
 * The other way a stopped Task ends. A Turn that was interrupted says so itself,
 * on the Turn; one that never began has no Turn to say anything, and the Task
 * still has to end as stopped rather than as a failure.
 */
class TaskStopped extends Error {
  constructor() {
    super('Task stopped before its Turn began')
    this.name = 'TaskStopped'
  }
}

/**
 * Add one attempt to what a Task has spent.
 *
 * Zero is a claim rather than a default, and it is only made where it is
 * certain: a Task that never reached Claude Code sent no message and spent
 * nothing. A Turn that began and produced no terminal event — a process that
 * died, a retry storm roma stopped waiting for — spent real tokens that nothing
 * will ever name, and recording those as zero would report money as free. That
 * is the same class of wrong as the cumulative total this whole ticket exists to
 * avoid, pointing the other way.
 */
function add(spend: Spend, turn: Turn | null, task: RunningTask): Spend {
  const turnMs = turn?.durationMs ?? spend.turnMs
  if (turn?.costUsd != null) {
    return { costUsd: (spend.costUsd ?? 0) + turn.costUsd, turnMs }
  }
  // Nothing priced this attempt. What earlier attempts were priced at stands,
  // and is now known to be less than the whole.
  if (spend.costUsd !== null) return { costUsd: spend.costUsd, turnMs }
  return { costUsd: task.turnBegan ? null : 0, turnMs }
}

/**
 * How a Task ended, as the audit record names it.
 *
 * Taken from the instruction the Conversation is about to be given rather than
 * remembered separately, so that the two can never disagree about how a Task
 * went. The other two instruction kinds cannot arrive here: `progress` is not an
 * ending, and a `command-outcome` belongs to a Command, which is not a Task.
 */
function outcomeOf(instruction: OutboundInstruction): TaskOutcome {
  if (instruction.kind === 'result') return 'result'
  if (instruction.kind === 'stopped') return 'stopped'
  return 'failure'
}

/**
 * Whether a Task ended because `/stop` reached it.
 *
 * Read off the ending rather than remembered from the Command: the Command is
 * carried out on another Task's behalf and returns immediately, so what stopped
 * a Task and what the Task's own outcome was would be two separate stories to
 * keep in step. There is no third party to consider either — roma interrupts a
 * Turn nowhere else, and abandons a retry storm by ending the process instead.
 */
function wasStopped(error: unknown): boolean {
  if (error instanceof TaskStopped) return true
  return error instanceof TurnFailedError && wasInterrupted(error.turn)
}

/**
 * What to tell the Conversation about a Task that produced no result.
 *
 * A failed Turn usually explains itself in its own text — "Failed to
 * authenticate. API Error: 401 API key is invalid." is Claude Code's sentence,
 * not ours, and it is more use than anything the Core could write about it.
 */
function reasonFor(error: unknown): string {
  if (error instanceof RetryStormError) return retryStormReason(error)
  if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
  return ROMA_FAILED
}

/**
 * What to say about a Task roma stopped waiting on.
 *
 * Named rather than folded into `ROMA_FAILED`, because this is the one failure
 * where roma made the decision and the person can act on it. A 401 here is a
 * credential someone has to go and fix; a 529 is worth sending again in a
 * minute. Neither is deducible from "roma could not run this Task."
 *
 * The status comes from the retry events themselves. The error proper never
 * arrives — it surfaces only once the retries are exhausted, which is precisely
 * the wait that was cut short.
 */
function retryStormReason({ retries, lastRetry }: RetryStormError): string {
  const cause = [lastRetry.errorStatus, lastRetry.error].filter((part) => part !== null).join(' ')
  const gaveUp = `roma gave up after ${retries} API ${retries === 1 ? 'retry' : 'retries'}`
  return cause === '' ? `${gaveUp}.` : `${gaveUp} (${cause}).`
}
