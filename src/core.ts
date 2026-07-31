import { randomUUID } from 'node:crypto'
import { Attempts, waitMsUntil } from './attempts.js'
import { monthOf, type AuditLog, type TaskOutcome } from './audit-log.js'
import type { CredentialKind } from './build-env.js'
import { attributed, attributedReadout } from './attribution.js'
import type {
  ChannelAdapter,
  IngressMessage,
  OutboundInstruction,
  TaskAddress,
} from './channel-adapter.js'
import { TurnFailedError, wasInterrupted, type Turn } from './claude-session.js'
import { readCommand, type Command, type CommandRequest } from './commands.js'
import { EnclosureUnreadable, writeEnclosures } from './enclosures.js'
import {
  MENU_NAMES,
  menuNameFor,
  PINNED_NAME,
  readModelRequest,
  type ModelRequest,
} from './model-menu.js'
import { readReadout } from './readouts.js'
import { ProgressReporter } from './progress-reporter.js'
import {
  ChosenModelNotOffered,
  type ChosenModels,
  type SessionGenerations,
} from './session-generation.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import { readSharedWindow, readSystemInit, type ClaudeEvent } from './stream-events.js'
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
export type CoreLogRecord =
  | {
      /**
       * Overflow was asked for and the monthly cap refused it.
       *
       * How the owner finds out, and the only place the numbers behind the
       * refusal are written down: the person who asked is told they were
       * refused, but a month that has spent its budget is not theirs to act on.
       */
      readonly event: 'overflow-refused'
      readonly taskId: string
      readonly month: string
      readonly capUsd: number
      readonly spentUsd: number
      /**
       * How much of that month's total is a floor rather than a figure — Tasks
       * nothing priced, and records that could not be read. Above zero, roma
       * refused on a number it knows to be an understatement.
       */
      readonly unpriced: number
      readonly unreadable: number
    }
  | {
      /**
       * A Readout drove a model Turn, which no entry on its list may.
       *
       * The drift check ADR-0012 built the Readout list around. Membership is a
       * person's judgement about a specific Claude Code build, and the container
       * image pin moves — so this is what says the judgement has expired, in the
       * one way a machine can see: an entry that used to answer locally is now
       * spending money and returning the model's opinion instead of the
       * command's output.
       *
       * An anomaly rather than traffic, which is why a Readout that behaves is
       * not logged here at all. The Operator Log is what roma decided and what
       * surprised it; a record per Readout would make it a traffic log, which
       * its own definition rejects.
       */
      readonly event: 'readout-drove-turn'
      readonly taskId: string
      readonly command: string
      readonly turns: number
      /** What that Turn cost, or null where nothing priced it. */
      readonly costUsd: number | null
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
   * Which Session each Conversation is on — only a question because `/clear` can
   * move one.
   *
   * Shared with every other Core over the same working directories, for the
   * reason the pool and the queue are: a Conversation two Cores each kept their
   * own answer for would be two Conversations, one of which never heard about
   * the `/clear`.
   */
  readonly sessions: SessionGenerations
  /**
   * Which model each Session runs on, and what the deployment pinned.
   *
   * Given to the Session Pool as well, which is what makes `/model` mean
   * anything: the Core writes what somebody chose and the pool reads it at the
   * next spawn. What the two have to agree on is the work root rather than the
   * object — nothing here is held between calls — and handing one instance to
   * both is how that agreement is made rather than assumed. A pool built without
   * it is the failure with no symptom: `/model` answers, the record is written,
   * and every Turn runs on the Pinned Model.
   */
  readonly models: ChosenModels
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
interface RunningTask extends TaskAddress {
  /**
   * The Session it is on, which is not always the one its Conversation is on: a
   * `/clear` in between moves the Conversation and leaves the Task where it
   * started.
   */
  readonly sessionId: string
  /**
   * The model this Task ran on, for its Audit Record.
   *
   * Read when the Task arrives so that a Task which never reaches a Turn still
   * names one, and read again immediately before each Attempt is sent — a Task
   * that waited behind three others is one somebody may have moved the model
   * under, and the ledger has to say what was actually spent rather than what was
   * true when it arrived. The pool reads the same record microseconds later to
   * decide what to spawn, which is as close as these two can be brought without
   * the Core being told how the pool works.
   */
  model: string
  /** Set by `/stop`, and read at each point the Task can still be stopped. */
  stopped: boolean
  /**
   * Every try this Task has made, and what may be tried next.
   *
   * Which credential is paying, what each try spent, what the stream said about
   * the Shared Window, and whether another wait is owed all live behind one
   * interface rather than as fields anything holding the Task can write to. The
   * Core asks it; it is not something the Core keeps in step.
   */
  readonly attempts: Attempts
  /**
   * Where this Task is waiting out the window, or null when it is not waiting.
   *
   * One object rather than three fields that have to be set and cleared in step:
   * being parked, the way to wake it, and whether an offer is outstanding are
   * the same fact, and the invariant is that they arrive and leave together.
   *
   * The handle rather than the decision: whether a wait is owed at all, and on
   * what terms, is `Attempts.takePark`. This is the timer it is being served on.
   *
   * The Task is doing nothing at all while this is set — no concurrency slot, no
   * process — which is what makes waiting hours for a reset affordable.
   */
  parked: Parked | null
}

/** A Task waiting for the Shared Window to come back. */
interface Parked {
  readonly wake: (resumption: Resumption) => void
  readonly timer: NodeJS.Timeout
  /** Whether an offer of Overflow is outstanding, and so whether one can be taken. */
  readonly offered: boolean
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
  readonly #models: ChosenModels
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
    models,
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
    this.#models = models
    this.#audit = audit
    this.#credential = credential
    this.#overflow = overflow ?? null
    this.#log = log ?? writeToStderr
  }

  /**
   * Take one message: a Command roma answers itself, a Readout it relays, or a
   * Task.
   *
   * All three are told apart here rather than in an Adapter, so that `/stop`
   * means the same thing on every Channel and a Channel cannot invent a fourth
   * kind of message. Everything that is none of them is work.
   *
   * Order matters, and only in one direction: a Command is checked first so
   * that roma's own three can never be shadowed by something added to the Readout
   * list. Nothing is on both lists today and this is what keeps that from
   * mattering — Claude Code has a `/stop` of its own, and roma's is the one that
   * must win. Since ADR-0013 the same is true of `/clear`, where it is a safety
   * property rather than a preference — see `COMMANDS` — and since ADR-0014 of
   * `/model`, which must never reach a process at all.
   *
   * Resolves when the Conversation has been told how it went. It rejects only
   * if the Channel could not be told at all — a failed Task is an outcome, not
   * an error, and reporting it is how this method succeeds.
   */
  async handle(message: IngressMessage): Promise<void> {
    const command = readCommand(message.text)
    if (command !== null) return await this.#runCommand(command, message)
    const readout = readReadout(message.text)
    if (readout !== null) return await this.#runReadout(readout, message)
    return await this.#runTask(message)
  }

  /**
   * Relay one of Claude Code's own commands and post what it said.
   *
   * Deliberately not `#runTask`, and the difference is not tidiness. A Readout
   * drives no Turn, so none of what makes a Task a Task applies to it: there are
   * no Attempts, because there is no credential decision to make and nothing to
   * park; there is no Shared Window reading, because no API call is made; there
   * is no Overflow, because there is nothing to spend. Reusing `#runTask` would
   * mean carrying all of that machinery through a path where every branch of it
   * is dead, and the dead branches are where a later reader looks for meaning
   * that is not there.
   *
   * What it does share is the two things a Readout genuinely has in common with
   * work: it is serialised against its Session, because two processes on one
   * transcript corrupt it, and it is written down, because the list it came from
   * is a person's judgement and can be wrong.
   *
   * **`/stop` does not reach one, and that is a gap rather than a decision.** A
   * Readout is not in `#running`, so `#stop` neither marks it nor counts it —
   * which means `/stop` in a Conversation whose only work in flight is a Readout
   * answers "nothing to stop" and then the Readout answers anyway. It costs
   * nothing and cannot be interrupted usefully once it runs, so what is actually
   * lost is a stale context reading arriving after the Task it queued behind.
   * Left alone because closing it means giving a Readout the shape of a
   * `RunningTask` — Attempts it has none of, a park it can never take — and that
   * is a wider change than the fault this was built for.
   */
  async #runReadout(command: string, message: IngressMessage): Promise<void> {
    const { conversationKey } = message
    const address = addressOf({ ...message, taskId: randomUUID() })
    const { taskId } = address
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) => this.#channel.deliver({ kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    // Held outside the try only so the Audit Record can name it, and null for
    // the one failure that happens before there is one: a Conversation whose
    // Session roma could not work out.
    let session: string | null = null
    // The same, for the model: a Readout runs on whatever process its Session
    // has, so its record names one for the same reason a Task's does.
    let model: string | null = null
    let turn: Turn | null = null
    try {
      const sessionId = this.#sessions.sessionFor(conversationKey)
      session = sessionId
      model = this.#models.modelFor(sessionId)
      // Acknowledged only where it cannot be answered at once, which is the
      // whole of ADR-0012's rule about this. A Readout on a Session with a live
      // process comes back in milliseconds, and an acknowledgement there would
      // be posted and superseded in the same breath — two messages for one
      // event, which is what ADR-0010 exists to prevent. The other two cases are
      // the ones where silence is what makes people resend: a cold start, said
      // here, and waiting for the Session's own work, said by the queue's notice
      // below.
      //
      // Computed rather than remembered. The Caller Marker is unconditional
      // precisely because a rule needing memory is lost across a restart; this
      // condition is read at the moment of asking, so there is nothing to lose.
      if (!this.#pool.residents.includes(sessionId)) reporter.update({ phase: 'working' })

      turn = await this.#queue.run(
        sessionId,
        () => this.#pool.send(sessionId, attributedReadout(message, command), this.#credential),
        {
          notice: (position) => reporter.update({ phase: 'queued', position }),
          // Serialised against the Session like anything else, and outside the
          // cap of three. See `About.uncapped` for why those are two answers
          // rather than one.
          uncapped: true,
          taskId,
        },
      )
      // Relayed as a `result`, which is what it is: text to be posted as its own
      // message in the Conversation. No instruction kind of its own, because an
      // Adapter has nothing to do differently with one — and a fifth kind would
      // be a concept every Channel had to learn for no change in behaviour.
      instruction = { kind: 'result', ...address, text: turn.text }
    } catch (error) {
      // A Readout that failed carries whatever the Turn said, exactly as a Task
      // does. `Unknown command: /x` arrives as a *successful* Turn rather than
      // here — an entry that has been removed from a later build answers, for
      // nothing, and telling the Caller what Claude Code said is more use than
      // roma paraphrasing it.
      if (error instanceof TurnFailedError) turn = error.turn
      instruction = { kind: 'failure', ...address, reason: reasonFor(error) }
    }

    // The drift check. Nothing on the Readout list may drive a Turn, and one
    // that did means the pin has moved under roma — so it is said out loud,
    // once, where an operator looks. Not said to the Caller: they asked a
    // question and got an answer, and what is wrong is roma's list rather than
    // anything they did.
    if (turn !== null && turn.turns !== null && turn.turns > 0) {
      this.#log({
        event: 'readout-drove-turn',
        taskId,
        command,
        turns: turn.turns,
        costUsd: turn.costUsd,
      })
    }

    // Written whatever it cost, including nothing — see `AuditRecord.kind`. A
    // Readout has one credential and no Attempts, so there is no second record
    // and no question of which one paid.
    this.#audit.record({
      kind: 'readout',
      taskId,
      caller: message.caller,
      callerName: message.callerName,
      sessionId: session,
      outcome: outcomeOf(instruction),
      // Zero rather than null where no Turn ran at all: a Readout that never
      // reached Claude Code spent nothing, and that is a fact rather than an
      // absence. Null is reserved for a Turn that began and nothing priced.
      costUsd: turn === null ? 0 : turn.costUsd,
      durationMs: Date.now() - startedAt,
      turnMs: turn?.durationMs ?? null,
      credential: this.#credential,
      model: model ?? this.#models.pinnedModel,
      apiKeySource: null,
    })

    reporter.stop()
    await this.#channel.deliver(instruction)
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
  async #runCommand(request: CommandRequest, message: IngressMessage): Promise<void> {
    const { conversationKey } = message
    // Not a Task, and it still gets an id — see `TaskAddress` for why. It is
    // addressed for the same reason: `/stop` is something one person typed, and
    // the answer to it is theirs rather than the Conversation's.
    const address = addressOf({ ...message, taskId: randomUUID() })

    let instruction: OutboundInstruction
    try {
      instruction =
        request.command === 'model'
          ? this.#answerModel(readModelRequest(request.argument), conversationKey, address)
          : {
              kind: 'command-outcome',
              ...address,
              command: request.command,
              carriedOut: this.#carryOut(request.command, conversationKey),
            }
    } catch (error) {
      // Silence is not an outcome here either. Nothing routine reaches this —
      // it takes a generation record roma cannot read, or a Conversation Key an
      // Adapter emptied — and either way the person is owed the difference
      // between a Command that did nothing because there was nothing to do and
      // one that did nothing because roma is broken.
      instruction = { kind: 'failure', ...address, reason: commandReasonFor(error) }
    }

    await this.#channel.deliver(instruction)
  }

  /**
   * Say which model this Conversation is on, or move it, and say so.
   *
   * Answered here rather than relayed, and that is the whole of ADR-0014: a
   * `/model` handed to the process would be a choice living inside something that
   * ends for reasons nobody using it can observe — an Eviction, a Reaping, a
   * deploy — so what a Caller would get is not model switching but a setting that
   * reverts at a moment they cannot see, on a bill nobody can attribute.
   *
   * **Nothing is torn down.** This writes the record and answers; the Session
   * Pool is what makes the next Turn run on it. So a Task already running
   * finishes on the model it started under and still answers the person who asked
   * — which is the reset Command's behaviour and is right for the same reason.
   * The reply has to say that out loud, though: a bare acknowledgement while a
   * Task is running would be read as having changed that Task.
   *
   * An answer rather than a `command-outcome`, because "it was carried out" is
   * not what any of these say. It is a `result` for the same reason a Readout's
   * output is one: text to be posted as its own message, which an Adapter already
   * knows how to do. A refusal is a `failure`, whose reason an Adapter passes
   * through — so a name roma does not offer is refused in the reply to the
   * message that contained it, addressed to whoever typed it, and Claude Code is
   * never asked about it.
   */
  #answerModel(
    request: ModelRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    // Which Session, not which Conversation. A Chosen Model belongs to a Session,
    // which is why clearing a Conversation puts it back on the Pinned Model
    // without anything being deleted.
    const sessionId = this.#sessions.sessionFor(conversationKey)

    // A switch rather than a chain of ifs, so that a fifth thing `/model` could
    // mean cannot be added without this stopping compiling.
    switch (request.kind) {
      case 'unknown':
        // Nothing is written, so a typo cannot move a Session somebody shares
        // with other people.
        return { kind: 'failure', ...address, reason: unknownModelReason(request.name) }
      case 'report':
        // No process, no Turn, no money, and no interruption of whatever this
        // Conversation is waiting on: roma owns the answer, so asking is never
        // the slow thing.
        return { kind: 'result', ...address, text: this.#modelReport(sessionId) }
      case 'default':
        this.#models.usePinnedModel(sessionId)
        // Named as `default` rather than by whatever the deployment pinned it
        // to, because `default` is the word they typed and the word they would
        // type again — and the id beside it says which model that turned out to
        // be.
        return {
          kind: 'result',
          ...address,
          text: fromNextMessage(PINNED_NAME, this.#models.pinnedModel),
        }
      case 'chosen':
        this.#models.choose(sessionId, request.model)
        return {
          kind: 'result',
          ...address,
          text: fromNextMessage(request.name, request.model),
        }
    }
  }

  /**
   * Which model this Session is on, and what else it may be on.
   *
   * Both spellings of the model, because they are answers to two different
   * questions a person has at once: the id is what the Audit Record and the
   * Operator Log call it, and the name is the only thing they may actually type —
   * the id is refused, deliberately, so a report that named it alone would offer
   * a list nothing in the sentence above it belonged to.
   */
  #modelReport(sessionId: string): string {
    // `chosenFor` rather than `modelFor`, because the two states that answer the
    // same string are not the same answer. A Session nobody moved *follows* the
    // Pinned Model and is named for it; one that was moved to the model the
    // deployment happens to pin follows nothing, and calling it "default" would
    // tell somebody who typed `/model sonnet` that an operator moving
    // `ROMA_MODEL` will take them along — which is the one thing their record
    // guarantees will not happen.
    const chosen = this.#models.chosenFor(sessionId)
    const model = chosen ?? this.#models.pinnedModel
    const name = chosen === null ? PINNED_NAME : menuNameFor(chosen)
    return (
      `This conversation is on ${named(name, model)}. ` + `You can choose: ${MENU_LIST}.`
    )
  }

  /** Do what the Command asks, and say whether there was anything to do. */
  #carryOut(command: Exclude<Command, 'model'>, conversationKey: string): boolean {
    if (command === 'clear') {
      // Nothing is torn down. `/clear` is aimed at what the *next* message
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
   * Session: a `/clear` between the message and the `/stop` moves the Conversation
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
    // date. Which is also why the Caller travels with it — one Conversation's
    // two Tasks can belong to two different people.
    const address = addressOf({ ...message, taskId: randomUUID() })
    const { taskId } = address
    // From arrival rather than from admission: queueing and cold start are time
    // the person spent waiting, and a Task stopped before it started has no
    // other duration at all.
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      // The Adapter is told whether it may edit; the Core is what obeys the
      // answer. Where it cannot, the acknowledgement is sent once and nothing
      // follows it.
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) => this.#channel.deliver({ kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    let running: RunningTask | null = null
    // Born before the Task it belongs to, because the Task is built inside the
    // try and a Conversation whose Session cannot be worked out fails before
    // there is one — and that failure is still audited.
    const attempts = new Attempts(this.#credential)
    try {
      // No lookup and nothing to have gone stale: the Conversation Key is the
      // Session id, one hash apart. The one thing read is which generation of it
      // `/clear` has left the Conversation on, and a Conversation that has never
      // used `/clear` is on the first. Read on arrival rather than on admission,
      // so that a message already waiting in the queue when a `/clear` lands still
      // goes to the Session it was sent to — and read inside the try, because a
      // Conversation roma cannot work out the Session for is one that would
      // otherwise be answered with silence.
      const sessionId = this.#sessions.sessionFor(conversationKey)
      // Known from here on rather than from the first token, so that `/stop`
      // reaches a Task that is queued or still starting its process.
      const task: RunningTask = {
        ...address,
        sessionId,
        model: this.#models.modelFor(sessionId),
        stopped: false,
        attempts,
        parked: null,
      }
      running = task
      this.#running.add(task)

      // Redeemed here and nowhere earlier, which is the whole of ADR-0011's
      // argument: the bytes are sized by whoever sent the message, and this is
      // the first moment roma knows they are wanted and knows the Working
      // Directory to put them in. A Task that was stopped, or parked until the
      // window came back, never reaches this line and never pays for them.
      // Guarded rather than left to `writeEnclosures` to no-op, so that a
      // message with nothing attached — nearly all of them — reaches the Turn
      // exactly as it did before Enclosures existed, touching no filesystem and
      // waiting on nothing.
      const enclosures =
        message.enclosures.length === 0
          ? []
          : await writeEnclosures(message.enclosures, this.#pool.cwdFor(sessionId))

      // Named above what they said rather than handed over beside it, because
      // the line written to stdin is the only per-Turn channel there is — see
      // `attributed`. Composed here rather than in an Adapter because an Adapter
      // that prefixed the text would turn `/stop` into something `readCommand`
      // no longer recognises, and CONTEXT.md has Commands read in the Core and
      // nowhere else.
      instruction = await this.#drive(task, attributed(message, enclosures), reporter)
    } catch (error) {
      // Two ways here: roma could not work out which Session the Conversation is
      // on, or an Enclosure could not be fetched. Everything after that is an
      // ending `#drive` describes. The second is not exotic — a Channel with a
      // class of attachment it cannot reach, which Chat's `driveDataRef` may
      // well be, arrives here every time somebody sends one.
      instruction = { kind: 'failure', ...address, reason: reasonFor(error) }
    } finally {
      if (running !== null) this.#running.delete(running)
    }

    // Written before the Channel is told, because the two obligations are
    // different and only one of them is anybody's to try again. An instruction
    // the Channel refuses is reported to whoever handed the message in; a record
    // dropped because the Channel was down would be a Task that spent money and
    // left no trace of who spent it, and nothing later can reconstruct it. This
    // cannot throw — see `AuditLog.record` — so it also cannot silence a Task.
    // The credential the answer came from, which is the one this Task is filed
    // under. Almost always the only one it used.
    const answeredOn = attempts.answeredOn() ?? this.#credential
    const durationMs = Date.now() - startedAt
    const outcome = outcomeOf(instruction)
    for (const credential of [answeredOn, ...attempts.credentials().filter((c) => c !== answeredOn)]) {
      const paid = attempts.spentOn(credential)
      // The Task's own record is written whatever it spent, including nothing.
      // A second one exists only where a second credential really paid for part
      // of it — a Shared Window Attempt the window cut short before roma reran
      // it on Overflow. Folded into one record it would be money filed under a
      // credential that did not spend it; left out it would be money nobody can
      // account for. Both records name the same Task.
      if (credential !== answeredOn && !paid.costUsd) continue
      this.#audit.record({
        taskId,
        caller: message.caller,
        // Both halves, because they answer the question at different removes: a
        // display name is what makes the record readable months later, and the
        // id is what still identifies somebody after they have changed it.
        callerName: message.callerName,
        // Null only where the Task failed before roma could work out which
        // Session it belonged to — the one failure that happens before it has one.
        sessionId: running?.sessionId ?? null,
        // Read off the instruction rather than tracked alongside it, so the
        // record and the Conversation cannot end up telling different stories.
        outcome,
        costUsd: paid.costUsd,
        durationMs,
        turnMs: paid.turnMs,
        credential,
        // What this Task ran on. The Pinned Model only where roma never got as
        // far as a Session to ask about — the same failure that leaves
        // `sessionId` null — because a row that says nothing is a row the month's
        // spending cannot be read against.
        model: running?.model ?? this.#models.pinnedModel,
        apiKeySource: attempts.apiKeySource(),
      })
    }

    // Nothing more is scheduled, and nothing in flight is waited on: an update
    // the Channel has not finished taking is not a reason to hold back the one
    // message roma owes unconditionally.
    reporter.stop()
    await this.#channel.deliver(instruction)
  }

  /**
   * Take a Task as far as an ending, however many Attempts that takes.
   *
   * More than one only when the Shared Window is spent. A blocked Task is not
   * over: ADR-0002 has roma say so, quote the reset time, and keep the Task — so
   * it waits, holding no concurrency slot and no process, and runs again when
   * the window comes back or when somebody takes Overflow.
   *
   * Every Attempt is its own decision about which credential pays. Overflow is
   * taken for one Attempt rather than for the Task, so a Task that takes it and
   * then fails again is back on the Shared Window and has to be offered it
   * afresh — which is also what keeps the monthly cap in front of every metered
   * Attempt rather than only the first.
   */
  async #drive(
    task: RunningTask,
    text: string,
    reporter: ProgressReporter,
  ): Promise<OutboundInstruction> {
    const { taskId, attempts } = task
    const address = addressOf(task)

    for (;;) {
      // Starting the Attempt is what fixes the credential paying for it and
      // clears the last one's reading of the window. Taking Overflow moves the
      // *next* Attempt's credential, so it cannot move this one out from under
      // the bill.
      const paidBy = attempts.begins()
      let turn: Turn | null = null
      let error: unknown = null
      try {
        turn = await this.#queue.run(
          task.sessionId,
          () => this.#runTurn(task, paidBy, text, reporter),
          {
            // The one thing roma will go without, and it is the reporter that
            // absorbs the failure: a Channel too broken to carry this is too
            // broken to carry the failure that abandoning the Task would
            // produce, so refusing to run it buys no less silence — it only adds
            // losing the work to it.
            notice: (position) => reporter.update({ phase: 'queued', position }),
            // So that the queue can say whose work this Session is doing while
            // it is doing it. Nothing about admission reads it — it is what lets
            // a credential request arriving from this Session be attributed to
            // this Task rather than to a guess.
            taskId,
          },
        )
      } catch (thrown) {
        error = thrown
        // A Turn that failed reports its own cost, and a Task that cost money
        // must be recorded whether or not it produced anything.
        if (thrown instanceof TurnFailedError) turn = thrown.turn
      }

      // Billed to whoever was paying for *that* Attempt. Summed across
      // credentials instead, a Shared Window Attempt the window refused would be
      // charged to the metered bill the Task later ran on — money the cap would
      // then refuse other people's work over, and a figure the reply would show
      // as having been spent on a card.
      attempts.ended(turn)
      // Back to the Shared Window for whatever comes next. Overflow applies to
      // one Attempt: left set, a Task that took it and failed would go on
      // spending metered money with nobody asked and no cap consulted.
      attempts.payWith(this.#credential)

      if (error === null && turn !== null) {
        return {
          kind: 'result',
          ...address,
          text: turn.text,
          // Only where somebody chose to spend money, and only what was spent
          // on that choice.
          ...(paidBy === 'overflow'
            ? { overflowCostUsd: attempts.spentOn('overflow').costUsd }
            : {}),
        }
      }

      // Parked rather than ended, if the window is what stopped it and nobody
      // has said to stop waiting.
      if (!task.stopped && (await this.#park(task))) continue

      // `task.stopped` as well as the Turn's own ending, because a Task stopped
      // while it was parked has a Turn that failed for whatever the window did
      // to it — reported as a failure, that reads as roma breaking rather than
      // as the thing somebody just asked for.
      return task.stopped || wasStopped(error)
        ? { kind: 'stopped', ...address }
        : { kind: 'failure', ...address, reason: reasonFor(error) }
    }
  }

  /**
   * Hold a Task the Shared Window has blocked, and say whether to run it again.
   *
   * False where the Attempt failed for any other reason — the reading is that
   * Attempt's own, cleared before it started, so a failure carrying none is a
   * failure the window had nothing to do with. False too where the event will
   * not say when the window comes back: a Task parked against a moment that
   * never arrives waits for ever, and nothing else in roma would come and look
   * at it.
   *
   * And false once a Task has waited twice. A parked Task holds no slot, so this
   * is not the halted-bot risk ADR-0003 lists — it is that a third "still
   * blocked" message is noise on a Conversation nobody is watching any more, and
   * that a Task which never ends is one nobody can be told about. Answered and
   * re-sendable beats held indefinitely.
   *
   * The Conversation is told before the waiting starts, and told best-effort —
   * the same judgement the acknowledgement gets. A Channel that cannot take this
   * message leaves somebody waiting without an explanation, which is worse than
   * silence for a moment and much better than losing the work.
   */
  async #park(task: RunningTask): Promise<boolean> {
    // Whether a wait is owed at all, and on what terms.
    const park = task.attempts.takePark()
    if (park === null) return false

    // Offered on what the provider says, not on what roma would like: a valve
    // the account cannot use is a button that spends somebody's attention and
    // then fails, at the moment they are already waiting. Whether roma has an
    // Overflow credential at all is the Core's half of it.
    const offered = this.#overflow !== null && park.overageAllowed
    await this.#tell({
      kind: 'blocked',
      ...addressOf(task),
      resetsAt: park.resetsAt,
      overflowOffered: offered,
    })

    const resumption = await new Promise<Resumption>((wake) => {
      // Measured here rather than above, so that however long the Channel took
      // to accept the message is not added to the wait.
      const timer = setTimeout(
        () => this.#wake(task, 'reset'),
        waitMsUntil(park.resetsAt, Date.now()),
      )
      timer.unref?.()
      task.parked = { wake, timer, offered }
    })
    this.#unpark(task)

    // Stopped while it waited. The acknowledgement goes back to saying the Task
    // is running on the next Attempt, which `#runTurn` does for itself.
    return resumption !== 'stopped'
  }

  /**
   * Take the offer of Overflow on one Task, and say whether there was one.
   *
   * A method rather than another Command. roma's are recognised only when the
   * whole message is one of them, and a `/overflow` anybody could type at any
   * moment would have to answer for itself when nothing is blocked.
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
      (candidate) => candidate.taskId === taskId && candidate.parked?.offered === true,
    )
    const overflow = this.#overflow
    if (task === undefined || overflow === null) return false

    const month = monthOf(new Date())
    const spent = this.#audit.totalFor(month, 'overflow')
    if (spent.costUsd >= overflow.monthlyCapUsd) {
      // How the owner finds out. The person who asked is told they were refused;
      // a month that has spent its budget is not theirs to act on, and both
      // counts are here so the refusal says how solid the number behind it was.
      this.#log({
        event: 'overflow-refused',
        taskId,
        month,
        capUsd: overflow.monthlyCapUsd,
        spentUsd: spent.costUsd,
        unpriced: spent.unpriced,
        unreadable: spent.unreadable,
      })
      // The Task stays parked. Refused is not abandoned — the window still comes
      // back, and this is still the Task that was blocked.
      await this.#tell({
        kind: 'overflow-refused',
        ...addressOf(task),
        capUsd: overflow.monthlyCapUsd,
        spentUsd: spent.costUsd,
      })
      return true
    }

    task.attempts.payWith('overflow')
    this.#wake(task, 'overflow')
    return true
  }

  /** Wake a parked Task, if it is still parked. */
  #wake(task: RunningTask, resumption: Resumption): void {
    const parked = task.parked
    if (parked === null) return
    this.#unpark(task)
    parked.wake(resumption)
  }

  /** Stop holding a Task, whichever way its wait ended. */
  #unpark(task: RunningTask): void {
    if (task.parked !== null) clearTimeout(task.parked.timer)
    task.parked = null
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
  async #runTurn(
    task: RunningTask,
    paidBy: CredentialKind,
    text: string,
    reporter: ProgressReporter,
  ): Promise<Turn> {
    // Stopped while it waited its turn. Starting it now would spend a Turn on
    // work somebody has already said they do not want, and then interrupt it.
    if (task.stopped) throw new TaskStopped()

    const { sessionId, attempts } = task
    // Read here rather than only on arrival: this Attempt is about to be sent,
    // and what it runs on is whatever the Session is on now — which is not what
    // it was on if this Task queued behind another one and somebody chose in
    // between.
    task.model = this.#models.modelFor(sessionId)
    reporter.update({ phase: 'working' })
    const onEvent = (id: string, event: ClaudeEvent): void => {
      if (id !== sessionId) return
      // The audit record's other half: which credential Claude Code itself says
      // is paying, rather than which one roma believes it handed over. One
      // arrives at the start of every Turn, so this is this Turn's own answer.
      const init = readSystemInit(event)
      if (init !== null) attempts.reported(init.apiKeySource)
      // One of these arrives on every Turn. Kept rather than acted on here: what
      // it means for a Turn that then failed is `Attempts.takePark`'s judgement,
      // and reading it in two places is how the two would come to disagree.
      const window = readSharedWindow(event)
      if (window !== null) attempts.saw(window)
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
      attempts.sent()
      if (task.stopped) this.#pool.interrupt(sessionId)
    }
    this.#pool.on('event', onEvent)
    this.#pool.on('turn-start', onTurnStart)
    try {
      // The credential this Attempt is billed to, handed down rather than read
      // again: one Attempt, one bill, and no second place for the two to differ.
      return await this.#pool.send(sessionId, text, paidBy)
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
 * What roma says when a Conversation has been put on a model.
 *
 * The one thing it must not leave out is *when*. `/model` is aimed at what the
 * next message reaches, and a bare acknowledgement sent while a Task is running
 * would be read as having changed that Task — so the sentence says both halves,
 * whether or not there is anything running to be confused about.
 *
 * Prose written by the Core, which an Outbound Instruction otherwise avoids. It
 * is here for the reason a failure's reason is: this reads the same on every
 * Channel, and the alternative is every Adapter growing its own copy of the Menu
 * and of this sentence.
 */
/**
 * The Menu as a sentence names it.
 *
 * Held once rather than joined at each of the two places that quote it, so a
 * report and a refusal cannot come to describe different Menus.
 */
const MENU_LIST = MENU_NAMES.join(', ')

function fromNextMessage(name: string, model: string): string {
  return (
    `This conversation runs on ${named(name, model)} from your next message. ` +
    `Anything already running finishes on the model it started under.`
  )
}

/**
 * One model, in both spellings a person needs.
 *
 * The name is what they may type and the id is what every record roma keeps calls
 * it, so a sentence carrying one of them sends somebody looking for the other.
 * The id alone where the Menu has no name for the model, which is what a
 * deployment that pinned something off the Menu has.
 */
function named(name: string | null, model: string): string {
  return name === null ? model : `${name} (${model})`
}

/**
 * What roma says about a name it does not offer.
 *
 * Named back, so it can be corrected in the next message, and the Menu is quoted
 * so the correction does not need looking up. That nothing changed is said
 * because a Conversation is shared: the people in it are owed the difference
 * between a model that moved and a typo that did not move one.
 */
function unknownModelReason(name: string): string {
  return (
    `roma does not offer a model called “${name}”. ` +
    `Choose one of: ${MENU_LIST}. Nothing has changed.`
  )
}

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
 * Which Task an instruction is about and whose it is, in one place.
 *
 * A function rather than four fields spread by hand at each of the nine places
 * an instruction is built. The failure it forecloses is a quiet one: an
 * instruction that forgot the Caller would still typecheck as long as some other
 * variable of the right name were in scope, and what an Adapter would do with it
 * is address somebody else's answer to whoever asked last.
 *
 * It takes anything that is already an address — a `RunningTask`, or an ingress
 * message with a freshly minted Task id spread onto it — and keeps only the four
 * fields an instruction carries.
 */
function addressOf({ taskId, conversationKey, caller, callerName }: TaskAddress): TaskAddress {
  return { taskId, conversationKey, caller, callerName }
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
  // Said rather than swallowed, unlike everything this function does not name.
  // What failed belongs to whoever sent it, they are the only person who can
  // act on it, and the Adapter that could not fetch it wrote the half of this
  // sentence that knows why — a Channel with an unreachable class of attachment
  // has its explanation here and nowhere else.
  if (error instanceof EnclosureUnreadable) return `roma could not read ${error.message}`
  if (error instanceof ChosenModelNotOffered) return chosenModelGoneReason(error)
  if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
  return ROMA_FAILED
}

/** The same, for a Command, whose generic failure is its own sentence. */
function commandReasonFor(error: unknown): string {
  return error instanceof ChosenModelNotOffered
    ? chosenModelGoneReason(error)
    : ROMA_FAILED_COMMAND
}

/**
 * What to say to a Conversation whose Chosen Model roma has stopped offering.
 *
 * Named for `retryStormReason`'s reason and one better: this is a failure roma
 * decided on, the person can act on it, and unlike a 401 they can act on it
 * *themselves* — which is why the sentence carries the way out rather than
 * describing the fault.
 *
 * It has to, because the fault is total. Every message in this Conversation
 * fails until the record goes, so a Caller who is not told `/model default`
 * fixes it has a thread that is simply broken, with the reason legible only to
 * whoever removed the Menu entry. Story 38 asked that removing one be noticed;
 * `ROMA_FAILED` on every message is noticed everywhere except where somebody
 * could do something about it.
 */
function chosenModelGoneReason({ model }: ChosenModelNotOffered): string {
  return (
    `This conversation is on ${model}, which roma no longer offers. ` +
    `Send “/model ${PINNED_NAME}” to put it back on the Pinned Model, ` +
    `keeping everything it has said.`
  )
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
