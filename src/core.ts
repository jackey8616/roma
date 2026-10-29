import { randomUUID } from 'node:crypto'
import { Attempts, waitMsUntil } from './attempts.js'
import {
  monthOf,
  type AuditBreakdown,
  type AuditLog,
  type CredentialSpend,
  type TaskOutcome,
} from './audit-log.js'
import type { CredentialKind } from './build-env.js'
import { attributed, relayed } from './attribution.js'
import {
  CAVEMAN_NAMES,
  CAVEMAN_NOT_PINNED,
  CAVEMAN_OFF,
  PINNED_CAVEMAN_NAME,
  readCavemanRequest,
  type CavemanRequest,
} from './caveman.js'
import type {
  ChannelAdapter,
  IngressMessage,
  OutboundInstruction,
  TaskAddress,
} from './channel-adapter.js'
import { TranscriptNotFound, TurnFailedError, wasInterrupted, type Turn } from './claude-session.js'
import { readCommand, type Command, type CommandRequest } from './commands.js'
import { severityOf, type CompactionSeverity } from './compaction.js'
import {
  EFFORT_NAMES,
  EFFORT_NOT_APPLIED,
  PINNED_EFFORT_NAME,
  readEffortRequest,
  takesEffort,
  type EffortRequest,
} from './effort-menu.js'
import { EnclosureUnreadable, writeEnclosures } from './enclosures.js'
import {
  MENU_NAMES,
  menuNameFor,
  PINNED_NAME,
  readModelRequest,
  type ModelRequest,
} from './model-menu.js'
import { readRelay, type RelayRequest } from './relays.js'
import { ProgressReporter } from './progress-reporter.js'
import { RUNTIME_NAMES, type Runtime } from './runtime.js'
import {
  ChosenCavemanNotOffered,
  ChosenEffortNotOffered,
  ChosenModelNotOffered,
  type ChosenRecord,
  type SessionGenerations,
} from './session-generation.js'
import { writeToStderr, type OperatorLog } from './operator-log.js'
import { RetryStormError, type SessionPool } from './session-pool.js'
import {
  readCompaction,
  readCompactionFailure,
  readSharedWindow,
  readSystemInit,
  type ClaudeEvent,
  type Compaction,
} from './stream-events.js'
import type { TaskQueue } from './task-queue.js'
import type { WorkRoot } from './work-root.js'

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
       * A Relay the list declares free did model work.
       *
       * The drift check ADR-0012 built the Relay list around. Membership is a
       * person's judgement about a specific Claude Code build, and the container
       * image pin moves — so this is what says the judgement has expired, in the
       * one way a machine can see: an entry that used to answer locally is now
       * spending money and returning the model's opinion instead of the
       * command's output.
       *
       * Enforced by `fence:core-free-relay-drift-is-one-way` and by `fence:core-manual-compaction-is-the-callers`.
       *
       * An anomaly rather than traffic, which is why a Relay that behaves is
       * not logged here at all. The Operator Log is what roma decided and what
       * surprised it; a record per Relay would make it a traffic log, which
       * its own definition rejects.
       */
      readonly event: 'free-relay-did-model-work'
      readonly taskId: string
      readonly command: string
      /** Output tokens the Turn produced, which for a free entry should be none. */
      readonly outputTokens: number
      /** What that Turn cost, or null where nothing priced it. */
      readonly costUsd: number | null
    }
  | {
      /**
       * A Compaction was attempted inside a Task and did not happen.
       *
       * Here and not on the Audit Record, which is the split #98 argues: a
       * Compaction that *worked* is a cost fact and prompts no decision, while
       * one that failed can mean a Session that will not serve another Turn —
       * which is squarely what an operator needs to know, and what roma has a
       * repair for.
       *
       * A benign failure is **not** written here. `too_few_groups` was measured
       * inside a Turn that cost two cents and answered normally, and a log line
       * per one of those would make this a traffic log rather than the record of
       * what surprised roma.
       */
      readonly event: 'compaction-failed'
      readonly taskId: string
      readonly sessionId: string
      /**
       * Claude Code's own code for it — a code and never the sentence, so an
       * operator grepping for one is not grepping for a build's error text.
       */
      readonly code: string | null
      /**
       * What roma made of that code, which is also what it decided to say.
       *
       * `unreducible` means the Caller was told their thread is full and that
       * `/clear` is the way out; `unexplained` means a code roma cannot read, so
       * this line is the only place it appears and nobody in the Conversation was
       * told anything. Never `benign` — those are not written at all.
       */
      readonly severity: Exclude<CompactionSeverity, 'benign'>
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
   * Where a Session works, asked of the Work Root rather than of the pool.
   *
   * The Core needs one path and needs it for one thing: an Enclosure has to be
   * on disk before the Turn that reads it (ADR-0011), and the Session it belongs
   * to may never have been spawned — the first message to a Conversation is as
   * likely to carry an Enclosure as any other. That is a question about where
   * roma keeps things, not about what is running, and the Session Pool only ever
   * answered it because it happened to be holding the path.
   *
   * Writing here still *creates* the Working Directory, and that is safe for a
   * reason this has nothing to do with: the pool stopped reading a directory's
   * existence as the record that a Session had been spawned, and reads
   * `.roma-session` instead (#105). Asking the Work Root rather than the pool
   * neither caused that nor fixes it — it is named here only so a reader does
   * not go looking for the guard in the wrong module.
   *
   * **The same one the pool has.** Enforced by
   * `fence:startup-core-and-pool-share-the-work-root`.
   */
  readonly workRoot: WorkRoot
  /**
   * Shared with every other Core, exactly as the pool is. Enforced by
   * `fence:startup-one-queue-for-every-channel`.
   */
  readonly queue: TaskQueue
  /**
   * Which Session each Conversation is on — only a question because `/clear` can
   * move one.
   *
   * Shared with every other Core over the same working directories. Enforced by
   * `fence:startup-one-session-record-for-every-channel`.
   */
  readonly sessions: SessionGenerations
  /**
   * Which model each Session runs on, and what the deployment pinned.
   *
   * Given to the Session Pool as well: the Core writes what somebody chose and
   * the pool reads it at the next spawn. Enforced by
   * `fence:startup-pool-reads-the-chosen-records`.
   */
  readonly models: ChosenRecord<'model'>
  /**
   * What effort each Session runs at, and what the deployment pinned.
   *
   * Given to the Session Pool as well, for the reason `models` is. Enforced by
   * `fence:startup-pool-reads-the-chosen-records`.
   */
  readonly efforts: ChosenRecord<'effort'>
  /**
   * How short each Session is asked to be, and what the deployment pinned.
   *
   * Given to the Session Pool as well, for the reason the two above are.
   * Enforced by `fence:startup-pool-reads-the-chosen-records`.
   */
  readonly cavemen: ChosenRecord<'caveman'>
  /**
   * Whether this deployment named a Caveman at all.
   *
   * A second field for one setting because it is not derivable from `cavemen`
   * above: `ROMA_CAVEMAN=off` and `ROMA_CAVEMAN` unset resolve to the same
   * Pinned Caveman before either reaches a Chosen Record, and the Audit Record
   * is the one place they may not be one string — `CAVEMAN_NOT_PINNED` is where
   * that difference is argued.
   *
   * A Caller who types `/caveman off` on a deployment that named none chose
   * something, and their Tasks are recorded as `CAVEMAN_NOT_PINNED` all the same.
   * Enforced by `fence:core-record-survives-a-withheld-caveman`.
   *
   * Omitted means no, which is what a deployment that named nothing has and what
   * every Core built for a test about something else has.
   */
  readonly cavemanPinned?: boolean
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
  /**
   * Whether one Task obtained a Cloud Token, asked once as its record is
   * written.
   *
   * A question rather than a component, because this is the whole of what the
   * Core is allowed to know about it: something outside answers yes or no, and
   * the Core prints the answer. Omitted, every record says no — which is exactly
   * right for a deployment with no Cloud Reach, where no Task can have used one.
   */
  readonly usedCloudReach?: (taskId: string) => boolean
  /**
   * Whether one Task obtained a Document Token, asked once as its record is
   * written.
   *
   * The question beside it, and a second question rather than one asked about a
   * provider: the Core prints two answers and cannot be asked whether there is a
   * Google. Omitted, every record says no — which is exactly right for a
   * deployment with no Document Reach, where no Task can have used one.
   *
   * What it answers is sharper than the cloud's. Everything the agent does in a
   * Depot is done as one service account, so Drive's own record of what happened
   * there names the account and never the person — and the Audit Record is the
   * only place a Caller exists at all (ADR-0002). Neither log answers "who put
   * this here" alone; joined on the Task's window, they narrow it (ADR-0022 §9).
   */
  readonly usedDocumentReach?: (taskId: string) => boolean
  readonly log?: CoreLog
}

/**
 * How a parked Task came to be running again, or not: the window comes back,
 * somebody buys their way past it, or somebody gives up. There is no fourth.
 */
type Resumption = 'reset' | 'overflow' | 'stopped'

/**
 * One Task this Core is in the middle of, as `/stop` needs to see it.
 *
 * Not derivable from the other two: the pool knows which Sessions have a Turn
 * in flight but not which Conversation asked, nor about a Task whose process is
 * still starting; the queue holds only opaque keys.
 */
interface RunningTask extends TaskAddress {
  /**
   * The Session it is on, which is not always the one its Conversation is on: a
   * `/clear` in between moves the Conversation and leaves the Task where it
   * started.
   */
  readonly sessionId: string
  /**
   * The Relay this is, or null where it is an ordinary Task.
   *
   * A paid Relay is governed as a Task in every respect (ADR-0018), so it is one
   * of these — and the two things that still differ about it are read off here:
   * what the Caller is told at the end, and that a Compaction failing inside it
   * is that Relay's own answer rather than something roma classifies.
   */
  readonly relay: RelayRequest | null
  /** Enforced by `fence:core-ledger-names-what-ran`. */
  model: string
  /** Enforced by `fence:core-ledger-names-what-ran`. */
  effort: string
  /** Enforced by `fence:core-ledger-names-what-ran`. */
  caveman: string | null
  /** Set by `/stop`, and read at each point the Task can still be stopped. */
  stopped: boolean
  /** Enforced by `fence:core-context-full-once-per-task`. */
  toldContextFull: boolean
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
  readonly #workRoot: WorkRoot
  readonly #queue: TaskQueue
  readonly #sessions: SessionGenerations
  readonly #models: ChosenRecord<'model'>
  readonly #efforts: ChosenRecord<'effort'>
  readonly #cavemen: ChosenRecord<'caveman'>
  readonly #cavemanPinned: boolean
  readonly #audit: AuditLog
  readonly #credential: CredentialKind
  readonly #overflow: OverflowOptions | null
  readonly #usedCloudReach: (taskId: string) => boolean
  readonly #usedDocumentReach: (taskId: string) => boolean
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
  /**
   * Each Session's Opening, as something to wait for: in flight, or long since
   * finished.
   *
   * Entered *before* the message is handed over rather than after, which is half
   * of what it is for: the record on disk is written once the Channel has taken
   * the Opening, and two messages arriving together in a brand-new Conversation
   * would both read that record as absent and both open. An entry is withdrawn
   * if the delivery failed, so this and the record agree about what "not yet
   * opened" means.
   *
   * The other half is why it holds a promise rather than a flag: a **second**
   * message arriving while the Opening is in flight has to wait for it too, or
   * its acknowledgement is posted above the Opening and the Opening is no longer
   * the first thing said in the Session. A flag would tell that message there was
   * nothing to do and let it straight past.
   *
   * Kept after it settles rather than cleared, so that every later message of the
   * Session has the same thing to wait on and gets it for free. A map that grew
   * per Session was going to exist either way; this one holds a settled promise
   * where it would have held a boolean.
   */
  readonly #openings = new Map<string, Promise<void>>()

  constructor({
    channel,
    pool,
    workRoot,
    queue,
    sessions,
    models,
    efforts,
    cavemen,
    cavemanPinned,
    audit,
    credential,
    overflow,
    usedCloudReach,
    usedDocumentReach,
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
    this.#workRoot = workRoot
    this.#queue = queue
    this.#sessions = sessions
    this.#models = models
    this.#efforts = efforts
    this.#cavemen = cavemen
    this.#cavemanPinned = cavemanPinned ?? false
    this.#audit = audit
    this.#credential = credential
    this.#overflow = overflow ?? null
    this.#usedCloudReach = usedCloudReach ?? (() => false)
    this.#usedDocumentReach = usedDocumentReach ?? (() => false)
    this.#log = log ?? writeToStderr
  }

  /**
   * Take one message: a Command roma answers itself, a Relay it hands over, or a
   * Task.
   *
   * All three are told apart here rather than in an Adapter, so that `/stop`
   * means the same thing on every Channel and a Channel cannot invent a fourth
   * kind of message. Everything that is none of them is work.
   *
   * A Command is checked before a Relay. Enforced by `fence:relays-no-command-overlap`.
   *
   * **A paid Relay goes down the Task path, and that is ADR-0018's whole
   * decision.** What tells a Relay from a Task is the shape the message takes on
   * the wire; what governs it is what it costs. Those are different axes, and
   * roma answered them together for as long as every entry on the list was free.
   * So a `/compact` is queued, capped, stoppable, Parkable, Overflowable and
   * audited by the machinery that already does all five — nothing is invented for
   * it, which is what makes it not a fourth kind of message.
   *
   * **The Opening sits on the seam the Command branch already cuts** (ADR-0024).
   * Everything past that line needs the Session's process — a Task, a paid Relay,
   * a free Relay — so one place covers all three, and a Command is excluded by
   * having returned rather than by being named again. That is the whole of why
   * roma never answers one question twice here: `/config` reports exactly the two
   * facts an Opening carries, and it cannot reach this line.
   *
   * Started here and waited for where the Channel is first told.
   * Enforced by `fence:core-opening-travels-with-the-message`.
   *
   * Resolves when the Conversation has been told how it went. It rejects only
   * if the Channel could not be told at all — a failed Task is an outcome, not
   * an error, and reporting it is how this method succeeds.
   */
  async handle(message: IngressMessage): Promise<void> {
    const command = readCommand(message.text)
    if (command !== null) return await this.#runCommand(command, message)
    const opened = this.#open(message)
    const relay = readRelay(message.text)
    if (relay !== null && relay.cost === 'free') {
      return await this.#runFreeRelay(relay, message, opened)
    }
    return await this.#runTask(message, relay, opened)
  }

  /**
   * Hand something over, once this message's Opening has gone out ahead of it.
   *
   * The whole of how an Opening stays first. Every instruction a Task or a Relay
   * produces goes through here, so ordering is a property of the one path they
   * share rather than a rule each delivery site has to remember — and the Opening
   * itself never comes this way, which is what keeps it from waiting on itself.
   *
   * `opened` cannot reject: `#open` absorbs every way an Opening can fail, since
   * none of them is a reason to withhold somebody's work.
   */
  async #deliverAfter(
    opened: Promise<void> | undefined,
    instruction: OutboundInstruction,
  ): Promise<void> {
    await opened
    await this.#channel.deliver(instruction)
  }

  /**
   * Say what this Session runs on, once, before it runs anything.
   *
   * roma's first reply in a Session and its own message, so that somebody whose
   * `/clear` has just put them back on the Pinned Model finds out from roma
   * rather than from an answer that reads oddly (ADR-0024). It drives no Turn and
   * spends nothing: both facts are records roma already holds.
   *
   * **Nothing here may cost the message that prompted it.** Three things can go
   * wrong and all three end the same way — no Opening, and the message carries on
   * exactly as it would have:
   *
   * - The Session cannot be worked out, or the record cannot be read. The first
   *   is a failure `#runTask` already owns and answers; duplicating it here would
   *   put two accounts of one fault in front of the Caller. The second leaves
   *   roma unable to say whether this Session is new, and an Opening it could not
   *   then record would arrive again on every message after it.
   * - The Channel refused it. Absorbed like progress, and the claim is withdrawn
   *   so the next message opens instead — a hiccup delays an Opening rather than
   *   losing it.
   *
   * The record is written **after** the Channel has taken the message. Written
   * first, one refusal would cost a Conversation its Opening permanently and
   * silently, and there is no third position: something has to be true before the
   * other.
   */
  async #open(message: IngressMessage): Promise<void> {
    let record: string
    let sessionId: string
    try {
      sessionId = this.#sessions.sessionFor(message.conversationKey)
      const already = this.#openings.get(sessionId)
      // Awaited rather than returned past, and that matters only for the message
      // that arrives while an Opening is still going out: waiting is what keeps
      // its acknowledgement from being posted above the Opening. For every
      // message after that this is a settled promise and one microtask.
      if (already !== undefined) return await already
      record = this.#workRoot.openedRecord(sessionId)
      if (this.#workRoot.readRecord(record) !== null) {
        this.#openings.set(sessionId, Promise.resolve())
        return
      }
    } catch {
      return
    }

    const opening = this.#deliverOpening(sessionId, record, message)
    // Registered before it is waited on, so that a message arriving while this
    // one is in flight finds something to wait for rather than opening again.
    this.#openings.set(sessionId, opening)
    await opening
  }

  /**
   * Hand one Opening over, and write the record if the Channel took it.
   *
   * Split from `#open` so that what is registered in `#openings` is the whole of
   * the delivery — registering a promise that stopped short of the record would
   * let a second message proceed believing an Opening had been recorded that had
   * not.
   */
  async #deliverOpening(sessionId: string, record: string, message: IngressMessage): Promise<void> {
    try {
      await this.#channel.deliver({
        kind: 'result',
        // Its own id, like a Command's answer: an Opening is not the Task that
        // prompted it, and an Adapter given one id for both would be editing one
        // message with the other. Addressed to whoever sent that message, because
        // a Caller belongs to a message and a Conversation has none of its own.
        ...addressOf({ ...message, taskId: randomUUID() }),
        text: this.#settingsReport(sessionId),
      })
    } catch {
      // Withdrawn rather than left behind, so the next message opens instead. A
      // message already waiting on this one rides the failed attempt and gets no
      // Opening at all — it arrived before roma knew there had been a refusal,
      // and re-deciding for it would mean a second Opening for whoever gets one.
      this.#openings.delete(sessionId)
      return
    }
    try {
      this.#workRoot.writeRecord(record, '')
    } catch {
      // The Opening was said and only the note of it was lost. Kept claimed
      // rather than withdrawn, so this Core does not say it twice; a restart
      // will, once, which is the cheaper of the two ways to be wrong about a
      // Work Root that cannot be written to.
      //
      // Never propagated, and that is the whole reason this is caught at all:
      // this promise is awaited by everything the message goes on to produce, so
      // a throw here would reject the Task's own delivery, hand the Delivery
      // back, and redeliver a Turn that has already been paid for.
    }
  }

  /**
   * Relay one of Claude Code's own commands that answers locally, and post what
   * it said.
   *
   * The free half of the Relay list, governed exactly as ADR-0012 left it.
   * Deliberately not `#runTask`, and the difference is not tidiness: a free
   * Relay drives no Turn, so none of what makes a Task a Task applies to it —
   * there are no Attempts, because there is no credential decision to make and
   * nothing to park; there is no Shared Window reading, because no API call is
   * made; there is no Overflow, because there is nothing to spend. Reusing
   * `#runTask` would mean carrying all of that machinery through a path where
   * every branch of it is dead, and the dead branches are where a later reader
   * looks for meaning that is not there.
   *
   * A **paid** Relay is the other way round: every one of those branches is live,
   * so it goes down `#runTask` and shares them rather than growing copies. That
   * is why this method is the free path by name rather than the Relay path — the
   * split is by cost, which is what ADR-0018 decided governance follows.
   *
   * What this does share with work is the two things a free Relay genuinely has
   * in common with it: it is serialised against its Session, because two
   * processes on one transcript corrupt it, and it is written down, because the
   * list it came from is a person's judgement and can be wrong.
   *
   * **`/stop` does not reach one, and that is a gap rather than a decision.** A
   * free Relay is not in `#running`, so `#stop` neither marks it nor counts it —
   * which means `/stop` in a Conversation whose only work in flight is one of
   * these answers "nothing to stop" and then the Relay answers anyway. It costs
   * nothing and cannot be interrupted usefully once it runs, so what is actually
   * lost is a stale context reading arriving after the Task it queued behind.
   * Left alone because closing it means giving this the shape of a `RunningTask`
   * — Attempts it has none of, a park it can never take. ADR-0018 closed the same
   * gap for the paid half by putting it on the path that already has both.
   */
  async #runFreeRelay(
    relay: RelayRequest,
    message: IngressMessage,
    opened: Promise<void>,
  ): Promise<void> {
    const { command } = relay
    const { conversationKey } = message
    const address = addressOf({ ...message, taskId: randomUUID() })
    const { taskId } = address
    const startedAt = Date.now()

    const reporter = new ProgressReporter({
      updates: this.#channel.capabilities.messageMutation,
      deliver: (progress) => this.#deliverAfter(opened, { kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    // Held outside the try only so the Audit Record can name it, and null for
    // the one failure that happens before there is one: a Conversation whose
    // Session roma could not work out.
    let session: string | null = null
    // The same, for the model and the effort: a Relay runs on whatever process
    // its Session has, so its record names both for the reason a Task's does.
    let model: string | null = null
    let effort: string | null = null
    let turn: Turn | null = null
    try {
      const sessionId = this.#sessions.sessionFor(conversationKey)
      session = sessionId
      model = this.#models.inForce(sessionId)
      effort = this.#efforts.inForce(sessionId)
      // Acknowledged only where it cannot be answered at once, which is the
      // whole of ADR-0012's rule about this — and it stays written for the four
      // free entries it was written for. A paid Relay gets the ordinary Task
      // Acknowledgement instead, unconditionally, because the premise here is
      // measured false there by a factor of twenty thousand.
      //
      // A free Relay on a Session with a live process comes back in
      // milliseconds, and an acknowledgement there would be posted and
      // superseded in the same breath — two messages for one event, which is
      // what ADR-0010 exists to prevent. The other two cases are the ones where
      // silence is what makes people resend: a cold start, said here, and
      // waiting for the Session's own work, said by the queue's notice below.
      //
      // Computed rather than remembered. The Caller Marker is unconditional
      // precisely because a rule needing memory is lost across a restart; this
      // condition is read at the moment of asking, so there is nothing to lose.
      if (!this.#pool.residents.includes(sessionId)) reporter.update({ phase: 'working' })

      turn = await this.#queue.run(
        sessionId,
        () => this.#pool.send(sessionId, relayed(message, relay), this.#credential),
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
      // A Relay that failed carries whatever the Turn said, exactly as a Task
      // does. `Unknown command: /x` arrives as a *successful* Turn rather than
      // here — an entry that has been removed from a later build answers, for
      // nothing, and telling the Caller what Claude Code said is more use than
      // roma paraphrasing it.
      if (error instanceof TurnFailedError) turn = error.turn
      instruction = { kind: 'failure', ...address, reason: reasonFor(error) }
    }

    // Enforced by `fence:core-free-relay-drift-is-one-way`.
    if (turn !== null && turn.outputTokens !== null && turn.outputTokens > 0) {
      this.#log({
        event: 'free-relay-did-model-work',
        taskId,
        command,
        outputTokens: turn.outputTokens,
        costUsd: turn.costUsd,
      })
    }

    // Written whatever it cost, including nothing — see `AuditRecord.kind`. A
    // free Relay has one credential and no Attempts, so there is no second record
    // and no question of which one paid.
    this.#audit.record({
      kind: 'relay',
      taskId,
      caller: message.caller,
      callerName: message.callerName,
      sessionId: session,
      outcome: outcomeOf(instruction),
      // Zero rather than null where no Turn ran at all: a Relay that never
      // reached Claude Code spent nothing, and that is a fact rather than an
      // absence. Null is reserved for a Turn that began and nothing priced.
      costUsd: turn === null ? 0 : turn.costUsd,
      durationMs: Date.now() - startedAt,
      turnMs: turn?.durationMs ?? null,
      credential: this.#credential,
      runtime: EVERY_SESSION_RUNS_ON,
      model: model ?? this.#models.pinned,
      effort: effortOn(model ?? this.#models.pinned, effort ?? this.#efforts.pinned),
      // Off the process that answered rather than out of the record beside the
      // two above, which is the rule the field carries everywhere. Read after
      // the Turn because that is when a Relay has a process at all: it reaches
      // whatever the Session has, and a Session that has been quiet all morning
      // has none until this line's work spawns one.
      caveman: this.#cavemanOnRecord(session === null ? null : this.#pool.cavemanOn(session)),
      // Zero rather than null where no Turn ran, for the reason the cost above
      // it is zero: a Relay that never reached Claude Code produced nothing, and
      // that is a fact rather than an absence.
      outputTokens: turn === null ? 0 : turn.outputTokens,
      // Asked rather than assumed false. A free Relay drives no Turn so nothing
      // it does can mint, but the answer is read-and-forget and a hard `false`
      // here would be roma writing down a fact it declined to check.
      cloudReach: this.#usedCloudReach(taskId),
      documentReach: this.#usedDocumentReach(taskId),
      apiKeySource: null,
    })

    reporter.stop()
    await this.#deliverAfter(opened, instruction)
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
      // Enforced by `fence:core-carry-out-names-its-two`.
      instruction =
        request.command === 'model'
          ? this.#answerModel(readModelRequest(request.argument), conversationKey, address)
          : request.command === 'effort'
            ? this.#answerEffort(readEffortRequest(request.argument), conversationKey, address)
            : request.command === 'caveman'
              ? this.#answerCaveman(readCavemanRequest(request.argument), conversationKey, address)
              : request.command === 'config'
                ? this.#answerConfig(request.argument, conversationKey, address)
                : request.command === 'usage'
                  ? this.#answerUsage(address)
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

  /** Enforced by `fence:core-model-never-relayed`. */
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
        // with other people. The Menu rides along, because this is the message
        // where somebody has just shown they do not know it (ADR-0023).
        return modelChoice(address, unknownModelReason(request.name), request.name)
      case 'report':
        // No process, no Turn, no money, and no interruption of whatever this
        // Conversation is waiting on: roma owns the answer, so asking is never
        // the slow thing.
        return modelChoice(address, this.#modelReport(sessionId), null)
      case 'default':
        this.#models.usePinned(sessionId)
        // Named as `default` rather than by whatever the deployment pinned it
        // to, because `default` is the word they typed and the word they would
        // type again — and the id beside it says which model that turned out to
        // be.
        return {
          kind: 'result',
          ...address,
          text:
            fromNextMessage(PINNED_NAME, this.#models.pinned) +
            this.#effortStranded(sessionId, this.#models.pinned),
        }
      case 'chosen':
        this.#models.choose(sessionId, request.model)
        return {
          kind: 'result',
          ...address,
          text:
            fromNextMessage(request.name, request.model) +
            this.#effortStranded(sessionId, request.model),
        }
    }
  }

  /** Enforced by `fence:core-unmeasured-model-keeps-effort`. */
  #effortStranded(sessionId: string, model: string): string {
    if (takesEffort(model) !== false) return ''
    const chosen = this.#efforts.chosenFor(sessionId)
    return chosen === null ? '' : ` ${takesNoEffort(model, chosen)}`
  }

  /**
   * Say what effort this Conversation runs at, or move it, and say so.
   *
   * `#answerModel`'s twin, never relayed for the same reason (ADR-0016) — the
   * build calls it `this session only`, and a session is a process.
   *
   * `--effort` is echoed nowhere in the stream, where `--model` comes back in
   * `system/init`. So this reply is roma saying what it will send rather than
   * reporting what it saw, which is why the Audit Record spells the effort as
   * weaker evidence than the model beside it.
   */
  #answerEffort(
    request: EffortRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    // Which Session, not which Conversation — a Chosen Effort belongs to a
    // Session, which is what makes `/clear` return it to the Pinned Effort
    // without anything being deleted.
    const sessionId = this.#sessions.sessionFor(conversationKey)

    switch (request.kind) {
      // Enforced by `fence:core-effort-menu-only-where-it-applies`.
      case 'unknown': {
        // Nothing is written, so a typo — or `ultracode`, which is the
        // operator's — cannot move a Session somebody shares with other people.
        const reason = unknownEffortReason(request.name)
        return this.#effortApplies(sessionId)
          ? effortChoice(address, reason, request.name)
          : { kind: 'failure', ...address, reason }
      }
      case 'report': {
        const text = this.#effortReport(sessionId)
        return this.#effortApplies(sessionId)
          ? effortChoice(address, text, null)
          : { kind: 'result', ...address, text }
      }
      case 'default':
        this.#efforts.usePinned(sessionId)
        return {
          kind: 'result',
          ...address,
          text:
            atNextMessage(PINNED_EFFORT_NAME, this.#efforts.pinned) +
            this.#modelTakesNone(sessionId),
        }
      case 'chosen':
        this.#efforts.choose(sessionId, request.level)
        return {
          kind: 'result',
          ...address,
          // Said on the way in as well as on a `/model` later, because this is
          // the message where somebody has just asked for something that will not
          // happen, and a bare acknowledgement would let them believe it did.
          text: atNextMessage(request.level, request.level) + this.#modelTakesNone(sessionId),
        }
    }
  }

  /**
   * What effort this Session runs at, and what else it may run at.
   *
   * `#modelReport`'s shape minus its two spellings: the name a Caller types is
   * the string roma passes to `--effort`.
   */
  #effortReport(sessionId: string): string {
    return (
      `This conversation runs at ${this.#effortNamed(sessionId)}. ` +
      `You can choose: ${EFFORT_LIST}.` +
      this.#modelTakesNone(sessionId)
    )
  }

  /** Enforced by `fence:core-named-as-typed`. */
  #effortNamed(sessionId: string): string {
    const chosen = this.#efforts.chosenFor(sessionId)
    return chosen ?? `${PINNED_EFFORT_NAME} (${this.#efforts.pinned})`
  }

  /**
   * The sentence an `/effort` owes when this Session's model takes none, or
   * nothing.
   *
   * `#effortStranded` pointing the other way, and deliberately without its
   * chosen-effort check: somebody who just typed `/effort max` is owed the
   * sentence whether or not a record already existed.
   */
  #modelTakesNone(sessionId: string): string {
    if (this.#effortApplies(sessionId)) return ''
    return ` ${takesNoEffort(this.#models.inForce(sessionId))}`
  }

  /** Enforced by `fence:core-unmeasured-model-keeps-effort`. */
  #effortApplies(sessionId: string): boolean {
    return takesEffort(this.#models.inForce(sessionId)) !== false
  }

  /** Enforced by `fence:core-caveman-menu-unconditional`. */
  #answerCaveman(
    request: CavemanRequest,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    // Which Session, not which Conversation — a Chosen Caveman belongs to a
    // Session, which is what makes `/clear` return it to the Pinned Caveman
    // without anything being deleted.
    const sessionId = this.#sessions.sessionFor(conversationKey)

    switch (request.kind) {
      case 'unknown':
        // Nothing is written, so a typo — or a wenyan level, which is the
        // operator's — cannot move a Session somebody shares with other people.
        // The Menu rides along, because this is the message where somebody has
        // just shown they do not know it (ADR-0023).
        return cavemanChoice(address, unknownCavemanReason(request.name), request.name)
      case 'report':
        // No process, no Turn, no money, and no interruption of whatever this
        // Conversation is waiting on: roma owns the answer, so asking is never
        // the slow thing.
        return cavemanChoice(address, this.#cavemanReport(sessionId), null)
      case 'default':
        this.#cavemen.usePinned(sessionId)
        return {
          kind: 'result',
          ...address,
          text: atNextCaveman(PINNED_CAVEMAN_NAME, this.#cavemen.pinned),
        }
      case 'chosen':
        this.#cavemen.choose(sessionId, request.level)
        return {
          kind: 'result',
          ...address,
          text: atNextCaveman(request.level, request.level),
        }
    }
  }

  /**
   * How short this Session is asked to be, and what else it may be asked.
   *
   * `#effortReport`'s shape: the name a Caller types is the level roma renders
   * the ruleset from, so there is only ever one spelling of it.
   */
  #cavemanReport(sessionId: string): string {
    return (
      `This conversation runs at caveman ${this.#cavemanNamed(sessionId)}. ` +
      `You can choose: ${CAVEMAN_LIST}.`
    )
  }

  /** Enforced by `fence:core-named-as-typed`. */
  #cavemanNamed(sessionId: string): string {
    const chosen = this.#cavemen.chosenFor(sessionId)
    return chosen ?? `${PINNED_CAVEMAN_NAME} (${this.#cavemen.pinned})`
  }

  /** Enforced by `fence:core-config-sets-nothing`. */
  #answerConfig(
    argument: string | null,
    conversationKey: string,
    address: TaskAddress,
  ): OutboundInstruction {
    if (argument !== null) {
      return { kind: 'failure', ...address, reason: CONFIG_SETS_NOTHING }
    }
    return {
      kind: 'result',
      ...address,
      text: this.#settingsReport(this.#sessions.sessionFor(conversationKey)),
    }
  }

  /** Enforced by `fence:core-usage-is-the-deployments`. */
  #answerUsage(address: TaskAddress): OutboundInstruction {
    return {
      kind: 'result',
      ...address,
      text: monthReport(this.#audit.breakdownFor(monthOf(new Date()))),
    }
  }

  /** Enforced by `fence:core-opening-says-what-config-says`. */
  #settingsReport(sessionId: string): string {
    const caveman = this.#cavemanWorthSaying(sessionId)
    return (
      `This conversation is on ${this.#modelNamed(sessionId)}, ` +
      `at ${this.#effortNamed(sessionId)}` +
      (caveman === null ? '' : `, at caveman ${caveman}`) +
      '. ' +
      (caveman === null
        ? `Change either with “/model” or “/effort”.`
        : `Change any with “/model”, “/effort” or “/caveman”.`) +
      this.#modelTakesNone(sessionId)
    )
  }

  /** Enforced by `fence:core-opening-says-what-config-says`. */
  #cavemanWorthSaying(sessionId: string): string | null {
    if (this.#cavemen.inForce(sessionId) === CAVEMAN_OFF) return null
    return this.#cavemanNamed(sessionId)
  }

  /**
   * Which model this Session is on, and what else it may be on.
   *
   * Both spellings: the id is what the Audit Record calls it, and the name is
   * the only thing a Caller may type — an id alone would offer a list nothing in
   * the sentence above it belonged to.
   */
  #modelReport(sessionId: string): string {
    return `This conversation is on ${this.#modelNamed(sessionId)}. You can choose: ${MENU_LIST}.`
  }

  /** Enforced by `fence:core-named-as-typed`. */
  #modelNamed(sessionId: string): string {
    const chosen = this.#models.chosenFor(sessionId)
    return named(chosen === null ? PINNED_NAME : menuNameFor(chosen), chosen ?? this.#models.pinned)
  }

  /** Do what the Command asks, and say whether there was anything to do. */
  #carryOut(command: Extract<Command, 'stop' | 'clear'>, conversationKey: string): boolean {
    // Enforced by `fence:core-carry-out-names-its-two`.
    switch (command) {
      case 'clear':
        // Nothing is torn down. `/clear` is aimed at what the *next* message
        // reaches: a Task already running in the old Session finishes and still
        // answers the person who asked, and the process behind it is left to
        // the pool, which reaps or evicts it like any other Session nobody is
        // talking to any more. Always true — a Conversation can always be given
        // a Session with nothing in it, including one that has never had a
        // Session at all.
        this.#sessions.freshSession(conversationKey)
        return true
      case 'stop':
        return this.#stop(conversationKey)
    }
  }

  /** Enforced by `fence:core-stop-reads-running`. */
  #stop(conversationKey: string): boolean {
    const mine = [...this.#running].filter((task) => task.conversationKey === conversationKey)
    for (const task of mine) {
      task.stopped = true
      // Enforced by `fence:core-stop-wakes-a-parked-task`.
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
   *
   * **`relay` is what a paid Relay comes down here as**, and how little it moves
   * is the measure of ADR-0018's claim that nothing was invented. It is read in
   * five places, listed here so the claim can be checked rather than believed:
   * what goes on the wire is a command rather than prose; Enclosures are not
   * redeemed; the reply is roma's to write; the Audit Record carries a `kind`;
   * and a Compaction that failed inside it is not roma's to classify. Everything
   * else — the queue, the cap, `/stop`, the park, Overflow, the Attempts, the
   * ledger — is shared rather than copied, which is the whole reason `/compact`
   * is a cell of the grid roma already had rather than a fourth kind of message.
   *
   * Two of the five are absences rather than behaviour, and both are the free
   * path's arrangements arriving here rather than anything new: ADR-0012 never
   * redeemed an Enclosure on a relayed command, and roma has never classified a
   * failure somebody asked for.
   */
  async #runTask(
    message: IngressMessage,
    relay: RelayRequest | null,
    opened: Promise<void>,
  ): Promise<void> {
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
      deliver: (progress) => this.#deliverAfter(opened, { kind: 'progress', ...address, progress }),
    })

    let instruction: OutboundInstruction
    let running: RunningTask | null = null
    // Born before the Task it belongs to, because the Task is built inside the
    // try and a Conversation whose Session cannot be worked out fails before
    // there is one — and that failure is still audited.
    const attempts = new Attempts(this.#credential)
    try {
      // Enforced by `fence:core-session-read-in-the-try`.
      const sessionId = this.#sessions.sessionFor(conversationKey)
      // Known from here on rather than from the first token, so that `/stop`
      // reaches a Task that is queued or still starting its process.
      const task: RunningTask = {
        ...address,
        sessionId,
        model: this.#models.inForce(sessionId),
        effort: this.#efforts.inForce(sessionId),
        caveman: null,
        stopped: false,
        toldContextFull: false,
        attempts,
        parked: null,
        relay,
      }
      running = task
      this.#running.add(task)

      // Enforced by `fence:core-enclosures-redeemed-late` and by `fence:core-relay-redeems-nothing`.
      const enclosures =
        relay !== null || message.enclosures.length === 0
          ? []
          : await writeEnclosures(message.enclosures, this.#workRoot.sessionDir(sessionId))

      // Named above what they said rather than handed over beside it, because
      // the line written to stdin is the only per-Turn channel there is — see
      // `attributed`. Composed here rather than in an Adapter because an Adapter
      // that prefixed the text would turn `/stop` into something `readCommand`
      // no longer recognises, and CONTEXT.md has Commands read in the Core and
      // nowhere else.
      //
      // A Relay goes on the wire as the command instead, because a marker above
      // one turns it into prose and Claude Code answers *about* it — the fault
      // ADR-0012 exists to fix, at five cents a go. Where it carries an argument
      // there is no marker at all, which `relayed` is where it is argued.
      instruction = await this.#drive(
        task,
        relay === null ? attributed(message, enclosures) : relayed(message, relay),
        reporter,
      )
      // What the Caller is told about a Relay is roma's to write, and only here:
      // `#drive` speaks for a Task and has no business knowing about `/compact`.
      if (relay !== null && instruction.kind === 'result') {
        instruction = { ...instruction, text: relayReply(attempts.compaction(), instruction.text) }
      }
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
    // Enforced by `fence:core-reach-asked-once`.
    const cloudReach = this.#usedCloudReach(taskId)
    const documentReach = this.#usedDocumentReach(taskId)
    for (const credential of [
      answeredOn,
      ...attempts.credentials().filter((c) => c !== answeredOn),
    ]) {
      const paid = attempts.spentOn(credential)
      // The Task's own record is written whatever it spent, including nothing.
      // A second one exists only where a second credential really paid for part
      // of it — a Shared Window Attempt the window cut short before roma reran
      // it on Overflow. Folded into one record it would be money filed under a
      // credential that did not spend it; left out it would be money nobody can
      // account for. Both records name the same Task.
      //
      // A Compaction keeps that second record alive on its own, and it has to: a
      // Compaction on an Attempt nothing priced is the "unpriced rather than
      // free" case with the largest known price tag there is, and a blocked
      // Attempt reran on Overflow is exactly the shape the field was put on the
      // Attempt for. Dropped here, the one Attempt that compacted leaves no trace
      // that it did.
      if (credential !== answeredOn && !paid.costUsd && paid.compaction === null) continue
      this.#audit.record({
        // Absent for a Task, which is what "absent means task" asks of the
        // writer, and `relay` for the one that arrived as a command. Nothing
        // about cost, deliberately: what this cost is in `costUsd`, and what it
        // says together with `compaction.trigger` is who asked for a Compaction —
        // `relay` plus `manual` is somebody typing `/compact` and paying for it.
        ...(relay === null ? {} : { kind: 'relay' as const }),
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
        // Which of the two bills, then whose. Outside the loop's business: the
        // credential moved between Attempts and a Session's Runtime is fixed for
        // its life (ADR-0025), so both records of one Task name the same one.
        runtime: EVERY_SESSION_RUNS_ON,
        // What this Task ran on. The Pinned Model only where roma never got as
        // far as a Session to ask about — the same failure that leaves
        // `sessionId` null — because a row that says nothing is a row the month's
        // spending cannot be read against.
        model: running?.model ?? this.#models.pinned,
        // And what it was asked to think at, said as weakly as roma knows it:
        // where the Matrix says the model takes no effort, the record says that
        // rather than naming a level nothing ran at.
        effort: effortOn(
          running?.model ?? this.#models.pinned,
          running?.effort ?? this.#efforts.pinned,
        ),
        // And how short. The level the process served it at, and what the
        // deployment would have given it where there was no process to ask.
        caveman: this.#cavemanOnRecord(running?.caveman ?? null),
        // What it produced, beside what it cost and split the same way: the two
        // Attempts of a Task that moved bills bought output on two of them.
        outputTokens: paid.outputTokens,
        cloudReach,
        documentReach,
        // Only where one happened, which is what "absent means no Compaction"
        // asks of the writer. On the record of the credential that paid for it:
        // a Task blocked on the Shared Window and rerun on Overflow spent that
        // money on one of the two bills, not on both.
        ...(paid.compaction === null ? {} : { compaction: paid.compaction }),
        apiKeySource: attempts.apiKeySource(),
      })
    }

    // Nothing more is scheduled, and nothing in flight is waited on: an update
    // the Channel has not finished taking is not a reason to hold back the one
    // message roma owes unconditionally.
    reporter.stop()
    await this.#deliverAfter(opened, instruction)
  }

  /** Enforced by `fence:core-caveman-not-pinned-on-record`. */
  #cavemanOnRecord(ranAt: string | null): string {
    const level = ranAt ?? this.#cavemen.pinned
    return !this.#cavemanPinned && level === CAVEMAN_OFF ? CAVEMAN_NOT_PINNED : level
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
      // Enforced by `fence:core-overflow-is-for-one-attempt`.
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

  /** Enforced by `fence:core-park-only-on-a-known-reset`. */
  async #park(task: RunningTask): Promise<boolean> {
    // Whether a wait is owed at all, and on what terms.
    const park = task.attempts.takePark()
    if (park === null) return false

    // Offered on what the provider says, not on what roma would like: a valve
    // the account cannot use is a button that spends somebody's attention and
    // then fails, at the moment they are already waiting. Whether roma has an
    // Overflow credential at all is the Core's half of it.
    const offered = this.#overflow !== null && park.overageAllowed
    await this.#tell(task, {
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
      await this.#tell(task, {
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

  /** Enforced by `fence:core-manual-compaction-is-the-callers`. */
  #compactionFailed(task: RunningTask, code: string | null): void {
    if (task.relay !== null) return

    const severity = severityOf(code)
    if (severity === 'benign') return

    this.#log({
      event: 'compaction-failed',
      taskId: task.taskId,
      sessionId: task.sessionId,
      code,
      severity,
    })
    if (severity !== 'unreducible' || task.toldContextFull) return
    task.toldContextFull = true
    void this.#tell(task, { kind: 'context-full', ...addressOf(task) })
  }

  /** Enforced by `fence:core-tell-absorbs-failures`. */
  async #tell(task: RunningTask, instruction: OutboundInstruction): Promise<void> {
    try {
      // Behind the Opening like everything else a Task produces. Looked up
      // rather than carried, because a Task already knows its Session and
      // threading the promise down to three notices would be three more
      // parameters for one ordering rule.
      await this.#deliverAfter(this.#openings.get(task.sessionId), instruction)
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
    // Enforced by `fence:core-stopped-before-its-turn`.
    if (task.stopped) throw new TaskStopped()

    const { sessionId, attempts } = task
    // Enforced by `fence:core-ledger-names-what-ran`.
    task.model = this.#models.inForce(sessionId)
    task.effort = this.#efforts.inForce(sessionId)
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
      // What this Attempt's money went on, where several times the ordinary
      // amount of it went on replacing a context nobody asked to have replaced.
      // Kept on the Attempt rather than on the Task, because the Attempt is what
      // one credential paid for.
      const compaction = readCompaction(event)
      if (compaction !== null) attempts.compacted(compaction)
      const failed = readCompactionFailure(event)
      if (failed !== null) this.#compactionFailed(task, failed.code)
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
      // And the moment the process serving it is known to exist, which is why
      // the Caveman is taken here rather than at the record: a Turn that dies
      // mid-flight leaves the pool holding no process to ask afterwards, and its
      // record is the one the ledger can least afford to guess at.
      task.caveman = this.#pool.cavemanOn(sessionId)
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
 * The Runtime every Session runs on, while a deployment has one to give
 * (ADR-0025).
 *
 * **Never go on writing this once a Session has a Runtime of its own** — the
 * point at which ADR-0027 has the record read it from there instead. A Codex
 * Task recorded as Claude Code's is filed against the wrong Shared Window, and
 * telling two windows apart is the only thing the field is for.
 */
const EVERY_SESSION_RUNS_ON: Runtime = 'claude-code'

/** Enforced by `fence:core-failure-in-romas-words`. */
const ROMA_FAILED = 'roma could not run this Task.'

/**
 * The same, for a Command — its own sentence because a Task can be sent again
 * and a Command will fail the same way until somebody looks at it.
 */
const ROMA_FAILED_COMMAND = 'roma could not carry out that command.'

/** Enforced by `fence:core-relay-reply-never-silent`. */
function relayReply(compaction: Compaction | null, text: string): string {
  const { preTokens = null, postTokens = null } = compaction ?? {}
  if (preTokens !== null && postTokens !== null) {
    return `Compacted: ${readableTokens(preTokens)} → ${readableTokens(postTokens)} tokens.`
  }
  // A boundary that arrived without its figures. It still happened, and saying so
  // without numbers beats inventing them or saying nothing.
  if (compaction !== null) return 'Compacted.'
  if (text !== '') return text
  return 'That command finished, and Claude Code said nothing about it.'
}

/** Enforced by `fence:core-token-counts-ignore-locale`. */
function readableTokens(tokens: number): string {
  return String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * The Menu as a sentence names it, joined once so that a report and a refusal
 * cannot come to describe different Menus.
 */
const MENU_LIST = MENU_NAMES.join(', ')

/** The Effort Menu as a sentence names it, held once for `MENU_LIST`'s reason. */
const EFFORT_LIST = EFFORT_NAMES.join(', ')

/** The Caveman Menu as a sentence names it, held once for `MENU_LIST`'s reason. */
const CAVEMAN_LIST = CAVEMAN_NAMES.join(', ')

/** A `/model` answer that carries the Model Menu to be chosen from. */
function modelChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'model', options: MENU_NAMES, refused }
}

/** An `/effort` answer that carries the Effort Menu to be chosen from. */
function effortChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'effort', options: EFFORT_NAMES, refused }
}

/** A `/caveman` answer that carries the Caveman Menu to be chosen from. */
function cavemanChoice(
  address: TaskAddress,
  text: string,
  refused: string | null,
): OutboundInstruction {
  return { kind: 'choice', ...address, text, chooses: 'caveman', options: CAVEMAN_NAMES, refused }
}

/** Enforced by `fence:core-model-reply-says-when`. */
function fromNextMessage(name: string, model: string): string {
  return (
    `This conversation runs on ${named(name, model)} from your next message. ` +
    `Anything already running finishes on the model it started under.`
  )
}

/**
 * The same, for the effort — its own sentence rather than a parameterised one,
 * because a model has two spellings and an effort has one, and "the model it
 * started under" is not a phrase about effort. Carries *when* for the same
 * reason `fromNextMessage` does.
 */
function atNextMessage(name: string, effort: string): string {
  return (
    `This conversation runs at ${name === effort ? name : `${name} (${effort})`} ` +
    `from your next message. Anything already running finishes at the effort it started at.`
  )
}

/**
 * The same again, for the Caveman.
 *
 * Its own sentence rather than a third caller of `atNextMessage`, and the word
 * "caveman" in it is why. Both settings are things a Conversation *runs at*, so
 * the effort's sentence reused here would say "This conversation runs at full"
 * — true, and silent about which of the two just moved, in a thread where
 * somebody has been typing both.
 */
function atNextCaveman(name: string, caveman: string): string {
  return (
    `This conversation runs at caveman ${name === caveman ? name : `${name} (${caveman})`} ` +
    `from your next message. Anything already running finishes at the caveman it started at.`
  )
}

/**
 * What roma says where the Effort Matrix says this model takes no effort.
 *
 * Says so and refuses nothing — the harm is a false belief, not a cost.
 *
 * Claims only what roma *read*, never what roma watched: the build echoes every
 * level on every model identically, so the only account of this is a reading of
 * a minified binary that has already been wrong once. Do not strengthen the
 * sentence past that.
 */
function takesNoEffort(model: string, chosen?: string): string {
  const setting = chosen === undefined ? 'Effort' : `The effort this conversation is at (${chosen})`
  return (
    `${setting} does not apply on ${model}, which takes none — ` +
    `it applies again on a model that does.`
  )
}

/**
 * What roma says about a level it does not offer.
 *
 * `unknownModelReason`'s shape and its reasons.
 *
 * `ultracode` arrives here like any other unknown name and must stay that way —
 * naming it would advertise something no Caller can have.
 */
function unknownEffortReason(name: string): string {
  return (
    `roma does not offer an effort called “${name}”. ` +
    `Choose one of: ${EFFORT_LIST}. Nothing has changed.`
  )
}

/**
 * What roma says about a Caveman it does not offer.
 *
 * `unknownEffortReason`'s shape and its reasons, and `ultracode`'s rule applies
 * to two names here rather than one: `wenyan-lite` and `wenyan-ultra` arrive like
 * any other unknown name and must stay that way, because naming them would
 * advertise something no Caller can have.
 */
function unknownCavemanReason(name: string): string {
  return (
    `roma does not offer a caveman called “${name}”. ` +
    `Choose one of: ${CAVEMAN_LIST}. Nothing has changed.`
  )
}

/**
 * What roma says to a `/config key=value`.
 *
 * Names the alternatives rather than a bare no: the person typing it is reaching
 * for one of the 35 keys Claude Code's own `/config` sets, and can have none of
 * them, because roma passes one config dir to every spawn.
 *
 * **Every Command that sets something, unconditionally.** Not the same list as
 * the report `/config` answers with, and not for the same reason: that sentence
 * says what this Session *is*, which ADR-0030 makes conditional on the
 * deployment having pinned a Caveman at all, where this one says what a Caller
 * *may type* — and `/caveman` is typable on every deployment there is.
 */
const CONFIG_SETS_NOTHING =
  'roma does not set Claude Code settings — every Session in this deployment shares one ' +
  'configuration, so a change here would be a change for everybody, permanently. ' +
  'What you can set for this conversation is “/model”, “/effort” and “/caveman”. ' +
  'Nothing has changed.'

/** Enforced by `fence:core-usage-never-one-figure`. */
function monthReport({ month, spend, unreadable }: AuditBreakdown): string {
  const named = monthNamed(month)
  // A refusal rather than a figure with a footnote under it. Either count above
  // zero says the records are not describing what they claim to, and a footnote
  // is not read as a reason to disbelieve the number above it.
  if (unreadable > 0 || spend.some(({ mismatched }) => mismatched > 0)) {
    return (
      `roma cannot vouch for ${named} and is printing no figure for it. ` +
      'Some of the month’s audit records cannot be read back, or name a credential ' +
      'Claude Code contradicted — either way a total here would be describing ' +
      'something other than what it says.'
    )
  }
  if (spend.every(({ tasks, relays }) => tasks + relays === 0)) return `${named}: nothing has run.`
  return [`${named}.`, ...spend.map(spendLine)].join('\n')
}

/** One credential's line on one Runtime, in the register that credential is read in. */
function spendLine({ runtime, credential, costUsd, unpriced }: CredentialSpend): string {
  // A floor where the month holds a Turn that began and was never priced. The
  // count itself stays off the line: a column that reads zero for ever is a
  // column nobody reads (ADR-0027).
  const figure = `${unpriced === 0 ? '' : 'at least '}$${money(costUsd)}`
  // Enforced by `fence:core-usage-never-one-figure`.
  const named = RUNTIME_NAMES[runtime]
  switch (credential) {
    case 'shared-window':
      return `${named}’s subscription drew ${figure} worth of work. Nobody is billed for that.`
    case 'overflow':
      return `Metered billing charged ${figure} for Tasks on ${named}.`
  }
}

/** Money as people read it, which is two decimal places and no more. */
function money(usd: number): string {
  return usd.toFixed(2)
}

/** The months in English, because a figure's month is read rather than filed. */
const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * Which month a report covers, and that it is a UTC one — `monthOf` slices an
 * ISO string, so it is deliberately not the reader's month (ADR-0027).
 */
function monthNamed(month: string): string {
  const [year, ordinal] = month.split('-')
  const name = MONTH_NAMES[Number(ordinal) - 1]
  if (name === undefined || year === undefined) return month
  return `${name} ${year} (UTC)`
}

/**
 * One model, in both spellings a person needs: the name is what they may type
 * and the id is what every record calls it. The id alone where the Menu has no
 * name for it, which is a deployment pinned off the Menu.
 */
function named(name: string | null, model: string): string {
  return name === null ? model : `${name} (${model})`
}

/**
 * What roma says about a name it does not offer.
 *
 * "Nothing has changed" is load-bearing: a Conversation is shared, and the
 * people in it are owed the difference between a model that moved and a typo
 * that did not move one.
 */
function unknownModelReason(name: string): string {
  return (
    `roma does not offer a model called “${name}”. ` +
    `Choose one of: ${MENU_LIST}. Nothing has changed.`
  )
}

/**
 * A Task that was stopped before it ever reached Claude Code — it has no Turn to
 * say so itself, and must still end as stopped rather than as a failure.
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
 * A function rather than four fields spread by hand at nine build sites, and the
 * failure it forecloses is quiet: an instruction that forgot the Caller still
 * typechecks whenever another variable of that name is in scope, and an Adapter
 * would then address somebody else's answer to whoever asked last.
 */
function addressOf({ taskId, conversationKey, caller, callerName }: TaskAddress): TaskAddress {
  return { taskId, conversationKey, caller, callerName }
}

/** Enforced by `fence:core-unmeasured-model-keeps-effort`. */
function effortOn(model: string, effort: string): string {
  return takesEffort(model) === false ? EFFORT_NOT_APPLIED : effort
}

/**
 * How a Task ended, as the audit record names it.
 *
 * Read off the instruction the Conversation is about to be given, never
 * remembered separately, so the two cannot disagree about how a Task went.
 */
function outcomeOf(instruction: OutboundInstruction): TaskOutcome {
  if (instruction.kind === 'result') return 'result'
  if (instruction.kind === 'stopped') return 'stopped'
  return 'failure'
}

/**
 * Whether a Task ended because `/stop` reached it.
 *
 * Read off the ending, never remembered from the Command: the Command returns
 * immediately on another Task's behalf, so the two would be separate stories to
 * keep in step. roma interrupts a Turn nowhere else.
 */
function wasStopped(error: unknown): boolean {
  if (error instanceof TaskStopped) return true
  return error instanceof TurnFailedError && wasInterrupted(error.turn)
}

/**
 * What to tell the Conversation about a Task that produced no result.
 *
 * A failed Turn usually explains itself, and Claude Code's own sentence is more
 * use than anything the Core could write about it.
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
  if (error instanceof ChosenEffortNotOffered) return chosenEffortGoneReason(error)
  if (error instanceof ChosenCavemanNotOffered) return chosenCavemanGoneReason(error)
  // Before the general failed Turn, which this is a kind of: it carries no text
  // at all, so left to that line it falls through to `ROMA_FAILED` — which is
  // what a whole Conversation was told, message after message, in #105.
  if (error instanceof TranscriptNotFound) return transcriptLostReason()
  if (error instanceof TurnFailedError && error.turn.text !== '') return error.turn.text
  return ROMA_FAILED
}

/** The same, for a Command, whose generic failure is its own sentence. */
function commandReasonFor(error: unknown): string {
  if (error instanceof ChosenModelNotOffered) return chosenModelGoneReason(error)
  if (error instanceof ChosenEffortNotOffered) return chosenEffortGoneReason(error)
  if (error instanceof ChosenCavemanNotOffered) return chosenCavemanGoneReason(error)
  return ROMA_FAILED_COMMAND
}

/**
 * What to say to a Conversation whose Chosen Model roma has stopped offering.
 *
 * Carries the way out rather than describing the fault, because the fault is
 * total: every message in this Conversation fails until the record goes, so a
 * Caller not told that `/model default` fixes it has a thread that is simply
 * broken, legible only to whoever removed the Menu entry.
 */
function chosenModelGoneReason({ model }: ChosenModelNotOffered): string {
  return (
    `This conversation is on ${model}, which roma no longer offers. ` +
    `Send “/model ${PINNED_NAME}” to put it back on the Pinned Model, ` +
    `keeping everything it has said.`
  )
}

/**
 * The same, for a Chosen Effort roma has stopped offering.
 *
 * A narrower hole than the model's — the Effort Menu holds every level the build
 * has, so the only way here is roma removing one. Total, and answered the same
 * way, because `/effort default` does not read the record at all.
 */
function chosenEffortGoneReason({ effort }: ChosenEffortNotOffered): string {
  return (
    `This conversation runs at ${effort}, which roma no longer offers. ` +
    `Send “/effort ${PINNED_EFFORT_NAME}” to put it back at the Pinned Effort, ` +
    `keeping everything it has said.`
  )
}

/**
 * The same, for a Chosen Caveman roma has stopped offering — the widest of the
 * three holes, which `ChosenCavemanNotOffered` argues, and answered identically
 * because the way out is identical.
 */
function chosenCavemanGoneReason({ caveman }: ChosenCavemanNotOffered): string {
  return (
    `This conversation runs at caveman ${caveman}, which roma no longer offers. ` +
    `Send “/caveman ${PINNED_CAVEMAN_NAME}” to put it back at the Pinned Caveman, ` +
    `keeping everything it has said.`
  )
}

/** Enforced by `fence:core-session-lost-reason`. */
function transcriptLostReason(): string {
  return (
    'roma could not open this conversation’s session, and starting a fresh one ' +
    'did not work either. Send “/clear” to move the conversation to a new session.'
  )
}

/**
 * What to say about a Task roma stopped waiting on.
 *
 * Not folded into `ROMA_FAILED`: a 401 here is a credential somebody must fix
 * and a 529 is worth resending in a minute, and neither is deducible from "roma
 * could not run this Task."
 *
 * The status comes from the retry events, because the error proper only surfaces
 * once retries are exhausted — precisely the wait that was cut short.
 */
function retryStormReason({ retries, lastRetry }: RetryStormError): string {
  const cause = [lastRetry.errorStatus, lastRetry.error].filter((part) => part !== null).join(' ')
  const gaveUp = `roma gave up after ${retries} API ${retries === 1 ? 'retry' : 'retries'}`
  return cause === '' ? `${gaveUp}.` : `${gaveUp} (${cause}).`
}
