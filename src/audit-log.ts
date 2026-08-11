import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs'
import { join } from 'node:path'
import { apiKeySourceFor, type CredentialKind } from './build-env.js'
import { writeToStderr } from './operator-log.js'
import type { Compaction } from './stream-events.js'

/** How a Task ended, in the three ways a Conversation is ever told about. */
export type TaskOutcome = 'result' | 'failure' | 'stopped'

/** The same three, for reading a record back off disk. */
const OUTCOMES: readonly TaskOutcome[] = ['result', 'failure', 'stopped']

/**
 * Whether a written figure is one this can be read back: a finite number, or the
 * null that says nothing reported one.
 *
 * Named for the shape rather than for the field, because two of them have it and
 * the null means something different in each — a Turn that began and was never
 * priced, and a Compaction the stream said no token count for.
 */
function isFigure(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Whether a written Compaction is one this can be read back.
 *
 * Checks the *shape*, never the fields: every one is nullable on the way in,
 * because the stream is not roma's. The shape is what a torn line loses, and a
 * record saying only that a Compaction happened still answers why this Task cost
 * five times its neighbours.
 */
function isCompaction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const { trigger, preTokens, postTokens } = value as Record<string, unknown>
  return (
    (trigger === null || typeof trigger === 'string') && isFigure(preTokens) && isFigure(postTokens)
  )
}

/**
 * What kind of work one record describes — the shape the message took on the
 * wire, and nothing about what it cost.
 *
 * Two values rather than three, deliberately. ADR-0018 separated the shape of a
 * message from what governs it, so a third value naming a *paid* Relay would
 * smuggle cost back into a field that is not about cost. What a Relay cost is
 * already on the record, in `costUsd`, and who asked for a Compaction is
 * `(kind, compaction.trigger)` between them: `task`+`auto` is a bill for a thread
 * the whole Conversation filled, `relay`+`manual` is a bill for a `/compact`.
 */
export type AuditKind = 'task' | 'relay'

/** The same, for reading a record back off disk. */
const KINDS: readonly AuditKind[] = ['task', 'relay']

/** One Task — or one Relay — written down. */
export interface AuditRecord {
  /** When the Task ended, ISO-8601 in UTC. */
  readonly at: string
  readonly taskId: string
  /**
   * Whether this was a Task or a Relay (ADR-0012, ADR-0018).
   *
   * Optional, and **absent means `task`**. Every record roma wrote before Relays
   * existed lacks it, and `readRecord` drops a line it cannot read — so requiring
   * this would make all of them unreadable at once, silently emptying the month
   * the Overflow cap is enforced against. That is the reasoning `callerName`
   * already carries, and it is the same failure.
   *
   * A free Relay is recorded at all because the list it comes from is maintained
   * by a person and can be wrong. "Ought to be free" is an assumption, and
   * writing no record would bake it into the ledger — the one place that has to
   * survive it being false. On the day an entry becomes a model Turn, the money
   * lands here instead of nowhere.
   *
   * **This value was spelled `readout` until ADR-0018, and no legacy spelling is
   * kept.** Records written before the rename are dropped by `readRecord`,
   * counted in `unreadable`, and absent from their month's `costUsd` — a genuine
   * breaking change to the ledger, chosen with it in view because the alternative
   * is a synonym that can never be deleted and has to be explained to every
   * future reader of a two-value enum with three values in it. It is not silent,
   * and it is avoidable by scheduling: deployed at a month boundary the loss is
   * entirely in a closed month, and the live Overflow cap is untouched.
   */
  readonly kind?: AuditKind
  /**
   * Whoever sent the message, named however the Channel names people.
   *
   * The reason this file exists. Everyone shares one subscription token, so the
   * provider has no idea who any of this was for — ADR-0002 — and there is no
   * second place to go and look it up afterwards.
   */
  readonly caller: string
  /**
   * The same person as a human reads them, in three states that mean three
   * different things:
   *
   * - a **name**, where the Channel had one;
   * - **null**, where it did not — an anonymous Chat user, or a delivery that
   *   carried no `displayName`;
   * - **absent**, where the record was written before ADR-0009 added the field.
   *
   * Optional for that last one, and it is not a formality. `readRecord` drops a
   * line it cannot read, and a dropped line drops out of the month's total —
   * which is the figure the Overflow cap is enforced against. Requiring this
   * would make every record roma wrote before the change unreadable at once,
   * silently resetting the month and letting the cap through. `caller` stays a
   * bare string for the same reason: it is what the old records have.
   */
  readonly callerName?: string | null
  /** Null for a Task that failed before roma could work out which Session it was for. */
  readonly sessionId: string | null
  readonly outcome: TaskOutcome
  /**
   * What this Task cost, as the per-Turn delta.
   *
   * Never `total_cost_usd` raw: that is cumulative for the process, so a fifth
   * Task logged raw is recorded at the sum of Tasks one through five, and the
   * monthly Overflow cap built on it would refuse spending that never happened.
   *
   * Three values rather than two, because "free" and "unpriced" are different
   * facts and only one of them can be added up:
   *
   * - a **number**, where a Turn ended and Claude Code priced it;
   * - **zero**, where no Turn ever began — a Task stopped while it was still
   *   queued spent nothing, and that is a fact rather than an absence;
   * - **null**, where a Turn began and nothing ever priced it. The cost arrives
   *   on the terminal event, so a Turn abandoned mid-retry-storm or cut short by
   *   a process that died has none — and the tokens it had already spent are
   *   real. Recording that as zero would report money as free, which is the same
   *   class of wrong as the cumulative total this field exists to avoid, only
   *   pointing the other way.
   */
  readonly costUsd: number | null
  /**
   * How long the person waited: from the message arriving to being told how it
   * went, queueing and cold start included.
   *
   * The Task's own wall-clock rather than the Turn's, because it is the only one
   * that exists for every ending — a Task stopped while it was still queued
   * never had a Turn — and the only one that describes what was actually endured.
   */
  readonly durationMs: number
  /** How much of that was the Turn itself. Null where no Turn ran. */
  readonly turnMs: number | null
  /** The credential roma ran this Task on. */
  readonly credential: CredentialKind
  /**
   * The model roma ran this Task on: the Session's Chosen Model, or the Pinned
   * Model where it had none.
   *
   * Here because a Chosen Model is a Caller moving the shared bill and nothing
   * else would remember which Task did (ADR-0014). The whole justification for
   * letting anybody do that is that it becomes answerable afterwards, and this is
   * where the answer is.
   *
   * Optional, and **absent means the Pinned Model** — which is what every record
   * roma wrote before ADR-0014 ran on, since nothing else was reachable. roma
   * writes it on every record all the same, so the ledger has no blank rows going
   * forward; the optionality is for reading the past. That is `callerName`'s
   * reasoning exactly: `readRecord` drops a line it cannot read, a dropped line
   * leaves the month's total, and the month's total is what the Overflow cap is
   * enforced against — so a required field would silently reset the month across
   * the deploy that added it.
   */
  readonly model?: string
  /**
   * What effort roma ran this Task at: the Session's Chosen Effort, the Pinned
   * Effort, or `EFFORT_NOT_APPLIED` where the Effort Matrix says the model takes
   * none.
   *
   * Here because ADR-0014's argument requires it: a decision whose justification
   * is that nobody can see afterwards what spent the shared window does not get
   * to leave that unrecorded, and a Chosen Effort is a Caller moving the shared
   * bill exactly as a Chosen Model is.
   *
   * **It is weaker evidence than the model beside it and must not be spelled as
   * though it were.** The model on a record was echoed by the process that ran
   * the Turn; the effort is what roma *sent*, boot-verified once, and interpreted
   * through a Matrix read off a binary — `system/init` carries no effort field at
   * all. Where that Matrix says the model takes no effort, this says so rather
   * than naming a level nothing ran at, because naming one would be the ledger
   * asserting something roma has read the opposite of.
   *
   * Optional, and **absent reads as unknown rather than as the Pinned Effort** —
   * which is the one place this differs from `model`. A record written before
   * this field ran on whatever the shared settings file happened to say, and roma
   * genuinely does not know what that was; labelling those retroactively would be
   * inventing a fact, which is the discipline `costUsd` already keeps by
   * distinguishing free from unpriced.
   *
   * Optional for the reason `callerName` and `kind` are, too: `readRecord` drops
   * a line it cannot parse, a dropped line leaves the month's total, and the
   * month's total is what the Overflow cap is enforced against.
   */
  readonly effort?: string
  /**
   * Whether this Task obtained a Cloud Token.
   *
   * A yes or a no, and deliberately **not a count** (ADR-0015 §10). One token
   * does unlimited API calls for an hour, so a number of mints is not a measure
   * of what was done and would be read as one — the same trade this file already
   * refuses in the other direction when it writes an unpriced Turn down as
   * unpriced rather than as free.
   *
   * Not *what* was reached for, either, because roma cannot know: a request to
   * the Cloud Shortcut carries no destination, and asking the agent to declare
   * one would record an unverifiable self-report.
   *
   * What it is for is the Google Cloud bill. Everything the agent does there is
   * done as one service account, so unexplained activity on it can be narrowed
   * to the people whose Tasks touched it — and nowhere else answers that.
   *
   * Optional, and **absent means no** — which is what every record roma wrote
   * before there were Cloud Reaches means, since there was no way to obtain one.
   * roma writes it on every record going forward. That is `model`'s reasoning
   * exactly: `readRecord` drops a line it cannot read, a dropped line leaves the
   * month's total, and the month's total is what the Overflow cap is enforced
   * against.
   */
  readonly cloudReach?: boolean
  /**
   * Whether this Task obtained a Document Token.
   *
   * A yes or a no, and deliberately **not a count**, for `cloudReach`'s reasons
   * unchanged: one token does unlimited work for an hour, and the request
   * carries no destination for roma to record (ADR-0022 §9).
   *
   * **What it is for is sharper than the field above.** Everything the agent does
   * in a Depot is done as one service account, so Drive's own audit log can say
   * what happened and never who asked — and the Audit Record is the only place a
   * Caller exists at all (ADR-0002). Neither log answers "who put this here"
   * alone; joined on the Task's own window, they narrow it. Given that one Depot
   * holds every Conversation's work, that question will be asked.
   *
   * The window is wider than the Task: a Document Token outlives the Task that
   * minted it by up to an hour. Recording the moment of the mint would narrow it
   * and is deliberately not done — it would be a third kind of field in an area
   * where only counts and destinations have been argued about, and the accuracy
   * has no question waiting for it.
   *
   * Optional, and **absent means no** — which is what every record roma wrote
   * before there were Document Reaches means, since there was no way to obtain
   * one. That is `cloudReach`'s reasoning exactly, and it is not a formality:
   * `readRecord` drops a line it cannot read, a dropped line leaves the month's
   * total, and the month's total is what the Overflow cap is enforced against, so
   * a required field would silently reset the month across the deploy that added
   * it.
   */
  readonly documentReach?: boolean
  /**
   * The Compaction that happened inside this Task, where one did.
   *
   * Here because it is the largest unexplained variation there is in what a Task
   * costs. Measured on byte-identical messages in one Session: $0.0917 against
   * $0.0186 — **4.9 times** — and twelve times the wall clock, and nothing on the
   * record told the two apart. That is the exact question an Audit Record exists
   * to answer, and it was being answered wrongly with no way to tell, because a
   * Compaction happens *inside* a Turn and a Conversation is many people sharing
   * one Session: whoever sent the message that crossed the threshold pays for
   * compacting a context the whole thread filled.
   *
   * It is a **cost fact and not an operational event**, which is why it is here
   * and not in the Operator Log. That log is what roma decided — an Eviction, a
   * Reaping, a refusal — and a successful Compaction prompts no decision at all:
   * roma cannot prevent it, delay it, or react to it.
   *
   * `trigger` is what makes it answer *who asked*, together with `kind` beside
   * it: a Task that compacted automatically is somebody's bad luck, and a
   * relayed `/compact` is somebody's choice (ADR-0018). No field is invented for
   * the question, which is why `/compact` needs no schema decision of its own.
   *
   * The token figures are `pre_tokens` and `post_tokens` and deliberately not
   * `cumulative_dropped_tokens`: that one is cumulative for the process the way
   * `total_cost_usd` is, so recording it would file every Compaction the Session
   * has ever had under this Task.
   *
   * Optional, and **absent means no Compaction happened** — which is what every
   * record roma wrote before it could see one says, since nothing could have
   * written it. That is `cloudReach`'s reasoning exactly: `readRecord` drops a
   * line it cannot read, a dropped line leaves the month's total, and the month's
   * total is what the Overflow cap is enforced against — so a required field
   * would silently reset the month across the deploy that added it.
   *
   * The stream's own reduction rather than a shape of the ledger's own, because
   * there is nothing here the ledger knows that the reader does not, and two
   * identical interfaces are two things to keep in step.
   */
  readonly compaction?: Compaction
  /**
   * What Claude Code said its credential resolved to — `apiKeySource` off
   * `system/init`, and null where no Turn reached that point.
   *
   * Recorded next to the credential above rather than instead of it, because the
   * two disagreeing is the failure ADR-0002 is most afraid of: a stray
   * `ANTHROPIC_API_KEY` silently moves every run onto metered billing, and the
   * only evidence is this field. Intent alone would record the reassuring half of
   * that, and the observation alone would lose what roma believed it was doing.
   */
  readonly apiKeySource: string | null
}

/**
 * An Audit Record before it has been stamped.
 *
 * The one field a caller does not supply, so that the stamp on a record and the
 * month it is filed under are one decision rather than two that can disagree.
 */
export type UnstampedRecord = Omit<AuditRecord, 'at'>

/**
 * What a calendar month of Tasks came to.
 *
 * `costUsd` is the number the Overflow cap is enforced on, and the three counts
 * beside it are every way that number can be less than the truth. None of them
 * is an error and none of them stops the total being returned — a cap that
 * refuses to be computed is a cap that cannot be enforced — but a caller
 * spending real money against this should read them before it does.
 */
export interface AuditTotal {
  readonly month: string
  /**
   * Tasks in the month. Relays are **not** counted here.
   *
   * Kept apart because this number is read as "how much work did this month
   * ask for", and folding Relays in would quietly turn it into "how many
   * messages were sent" — a Conversation where somebody checked `/context`
   * forty times would read as forty Tasks. Their cost is another matter and is
   * in `costUsd` below.
   */
  readonly tasks: number
  /** Relays in the month, counted separately for the reason above. */
  readonly relays: number
  /**
   * What the month spent, Relays included.
   *
   * Everything that cost anything, whatever kind of thing it was. Most of the
   * Relay list is expected to cost nothing and is summed anyway: the moment one
   * of those does not, the cap this feeds is the thing that has to know, and a
   * total that filtered by kind would be enforcing against a figure it had
   * chosen not to see. Since ADR-0018 one entry is expected to cost money, and
   * this is the sentence that already covered it.
   */
  readonly costUsd: number
  /**
   * Tasks in the total whose cost was never reported, and which are therefore in
   * `tasks` but not in `costUsd`.
   *
   * A Turn that began and never reached a terminal event: abandoned mid-retry-
   * storm, or cut short by a process that died. Whatever it had already spent is
   * real and unrecoverable, so the honest reading of this total is "at least
   * `costUsd`, over `tasks` Tasks, `unpriced` of which are not in the figure".
   */
  readonly unpriced: number
  /**
   * Records in this month that could not be read.
   *
   * Reported rather than thrown or ignored, because both of those answer the
   * Overflow cap's question wrongly: a total that refuses to be computed leaves
   * the cap unenforceable, and one that quietly skips a line under-reports spend
   * and lets the cap through. A caller that cares can refuse to spend while this
   * is above zero.
   *
   * Counted whatever credential was asked for, because a line that cannot be
   * read cannot be said to belong to one credential rather than the other. That
   * makes an Overflow-only total look tainted by a torn Shared Window record,
   * which is the conservative way round: the alternative is a cap that quietly
   * assumes the line it could not read was not spending.
   */
  readonly unreadable: number
  /**
   * Records where the credential roma ran the Task on is not the one Claude Code
   * said was paying.
   *
   * Above zero means the total below is describing money that came out of
   * somewhere else, and the number to act on is which credential is really being
   * billed rather than this one.
   */
  readonly mismatched: number
}

/** Both credentials, for reading a record back and for the order a month reports them in. */
const CREDENTIALS: readonly CredentialKind[] = ['shared-window', 'overflow']

/**
 * What one credential drew in a calendar month.
 *
 * The four figures are `AuditTotal`'s, counted over this credential's records
 * alone. What is not here is `unreadable`: a line that cannot be read cannot be
 * said to belong to one credential rather than the other, so it belongs to the
 * month.
 *
 * Kept apart from the other credential and **never added to it**. A Shared
 * Window Task carries a `costUsd` because Claude Code prices every Turn and
 * nobody is billed it, so one sum reports subscription draw as money — the
 * arithmetic the Overflow cap already refuses (ADR-0027).
 */
export interface CredentialSpend {
  readonly credential: CredentialKind
  readonly tasks: number
  readonly relays: number
  readonly costUsd: number
  readonly unpriced: number
  /**
   * Records roma filed under this credential that Claude Code contradicted.
   *
   * Per credential because `totalFor` has always counted it for the credential
   * it was asked about. What may not be done with it is print it beside that
   * credential's figure: the count says the record's own `credential` is not to
   * be believed, so attributing it to one is asserting the thing in doubt. A
   * report reads it for the month and prints no number (ADR-0027).
   */
  readonly mismatched: number
}

/**
 * One calendar month, split by credential, plus the one count that has no
 * credential to belong to.
 *
 * **The only walk of a month's file there is.** `totalFor` folds this down, so a
 * caller that wants both figures asks once — where two filtered totals would
 * read the month from disk twice and count every unreadable line in each of
 * them, reporting one torn record as two.
 */
export interface AuditBreakdown {
  readonly month: string
  /** One entry per credential, both always present, in the order above. */
  readonly spend: readonly CredentialSpend[]
  /** The month's, and what `AuditTotal.unreadable` carries whole. */
  readonly unreadable: number
}

/** One column of a month's credentials, added up. */
function sumOf(
  spend: readonly CredentialSpend[],
  field: keyof Omit<CredentialSpend, 'credential'>,
) {
  return spend.reduce((total, entry) => total + entry[field], 0)
}

/** What one credential has drawn so far, while the walk is still going. */
interface Tally {
  tasks: number
  relays: number
  costUsd: number
  unpriced: number
  mismatched: number
}

/**
 * Whether the credential roma ran a Task on is the one that paid for it.
 *
 * Asked against `apiKeySourceFor` rather than a table of its own, so that this
 * and the startup self-check cannot come to different conclusions about the same
 * credential. True where nothing was observed: a Task with no Turn behind it has
 * no `apiKeySource` and also spent nothing, so it is evidence of nothing.
 */
function paidAsIntended({ credential, apiKeySource }: AuditRecord): boolean {
  return apiKeySource === null || apiKeySource === apiKeySourceFor(credential)
}

/**
 * The calendar month a moment falls in, as the records of it are filed.
 *
 * UTC, and exported because every caller of `totalFor` needs it: a month has to
 * be a fixed set of records rather than one that depends on where the reader is
 * standing, and that rule belongs in one place rather than in each caller's
 * arithmetic.
 */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7)
}

export interface AuditLogOptions {
  /**
   * Where the records go.
   *
   * Deliberately not under the Work Root: that tree is
   * walked by a reclaim that deletes anything nothing has touched for seven
   * days, and these records are exactly what has to survive a quiet week.
   */
  readonly auditRoot: string
  /**
   * Where a record goes when it cannot be written to disk. One JSON object per
   * line on stderr by default.
   */
  readonly onWriteFailed?: (record: AuditRecord, error: unknown) => void
}

/** The fallback: at least get the record into the process's log stream. */
const reportToStderr = (record: AuditRecord, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error)
  writeToStderr({ event: 'audit-write-failed', reason, record })
}

/**
 * Every Task roma has run, one line each, kept for as long as the disk keeps it.
 *
 * This is the only place per-user attribution exists. Everybody shares one
 * subscription token (ADR-0002), so the provider sees one customer and can never
 * be asked who spent what — the question is answerable here or nowhere.
 *
 * Two properties follow from what the records are for rather than from taste:
 *
 * - **A month is a file.** The monthly Overflow cap is a calendar-month sum, so
 *   the sum is one file read rather than a scan of everything roma has ever
 *   done, and a month that has passed is never appended to again.
 * - **A record is written where it can be read again.** Held in memory it would
 *   describe money right up until the next deploy and then be gone, which is the
 *   one failure this cannot have: the number it carries is not recoverable from
 *   anywhere else afterwards.
 */
export class AuditLog {
  readonly #auditRoot: string
  readonly #onWriteFailed: (record: AuditRecord, error: unknown) => void

  constructor({ auditRoot, onWriteFailed = reportToStderr }: AuditLogOptions) {
    this.#auditRoot = auditRoot
    this.#onWriteFailed = onWriteFailed
    // Here rather than at the first Task, so that a roma pointed at a directory
    // it cannot write to says so while it is starting — the boot is the last
    // moment anybody is watching, and a Task that discovers it is the first Task
    // whose cost is already lost.
    mkdirSync(auditRoot, { recursive: true })
  }

  /**
   * Write one Task down.
   *
   * **Never throws**, and that is the design rather than an oversight. It is
   * called on the way to telling somebody how their Task went, and a Task that
   * ran, spent money and then answered nobody because the disk was full would be
   * the worse of the two failures. A record that cannot be written is handed to
   * `onWriteFailed` instead, which by default puts it on stderr — the container's
   * log stream is not the audit log, but it is somewhere, and somewhere beats the
   * only copy being dropped on the floor.
   */
  record(task: UnstampedRecord): void {
    // Stamped here so that the time on the record and the month it is filed
    // under are one decision. A Task that started in July and ended in August is
    // an August record: the alternative is appending to a month that may already
    // have been totalled and acted on.
    const at = new Date()
    const record: AuditRecord = { at: at.toISOString(), ...task }
    const line = `${JSON.stringify(record)}\n`
    try {
      const file = this.#fileFor(monthOf(at))
      // Start a new line first if the file was left mid-line. A machine that
      // loses power mid-append leaves a line with no newline on the end of it,
      // and appending straight onto that joins the next record to the wreckage —
      // costing the month a second record, this one a Task that really did
      // happen. One torn line is the most a power loss may cost.
      //
      // Checked on every append rather than once per file per run. The cheaper
      // version assumes nothing else ever writes here, and the day something
      // does — a second roma over the same volume, somebody's script — the
      // assumption is not wrong loudly, it is wrong by silently eating a record.
      appendFileSync(file, endsWhole(file) ? line : `\n${line}`, 'utf8')
    } catch (error) {
      this.#onWriteFailed(record, error)
    }
  }

  /**
   * Every record of one calendar month, in the order the Tasks ended.
   *
   * UTC, because a month has to be a fixed set of records rather than one that
   * depends on where the reader is standing.
   */
  readMonth(month: string): AuditRecord[] {
    return this.#linesOf(month).flatMap((line) => {
      const record = readRecord(line)
      return record === null ? [] : [record]
    })
  }

  /**
   * What one calendar month came to, per credential and unsummed.
   *
   * Every rule for reading this file lives here, because every other reading is
   * folded from it. A second walk written beside this one is a second answer to
   * "what is in the month" that nothing keeps in step.
   */
  breakdownFor(month: string): AuditBreakdown {
    const drawn: Record<CredentialKind, Tally> = {
      'shared-window': { tasks: 0, relays: 0, costUsd: 0, unpriced: 0, mismatched: 0 },
      overflow: { tasks: 0, relays: 0, costUsd: 0, unpriced: 0, mismatched: 0 },
    }
    let unreadable = 0

    for (const line of this.#linesOf(month)) {
      const record = readRecord(line)
      if (record === null) {
        unreadable += 1
        continue
      }
      const tally = drawn[record.credential]
      // A record written before Relays existed carries no kind and is a Task,
      // which is the only thing it can have been. A record written before the
      // ADR-0018 rename carries `readout` and never reaches here at all —
      // `readRecord` drops it, and it is counted in `unreadable` above.
      if (record.kind === 'relay') tally.relays += 1
      else tally.tasks += 1
      // Counted as having happened and left out of the money, which is the only
      // honest pair of answers: it happened, and what it cost is not knowable.
      if (record.costUsd === null) tally.unpriced += 1
      else tally.costUsd += record.costUsd
      if (!paidAsIntended(record)) tally.mismatched += 1
    }

    return {
      month,
      spend: CREDENTIALS.map((credential) => ({ credential, ...drawn[credential] })),
      unreadable,
    }
  }

  /**
   * What one calendar month came to, which is what the Overflow cap needs.
   *
   * Filtered by credential where the caller has one in mind: the cap is on
   * metered spend, and Shared Window Tasks are not spend in the sense it means.
   * `unreadable` is carried whole either way — see the field.
   */
  totalFor(month: string, credential?: CredentialKind): AuditTotal {
    const { spend, unreadable } = this.breakdownFor(month)
    const counted =
      credential === undefined ? spend : spend.filter((entry) => entry.credential === credential)

    return {
      month,
      tasks: sumOf(counted, 'tasks'),
      relays: sumOf(counted, 'relays'),
      costUsd: sumOf(counted, 'costUsd'),
      unpriced: sumOf(counted, 'unpriced'),
      unreadable,
      mismatched: sumOf(counted, 'mismatched'),
    }
  }

  /** A month nothing was written in reads as a month with nothing in it. */
  #linesOf(month: string): string[] {
    let contents: string
    try {
      contents = readFileSync(this.#fileFor(month), 'utf8')
    } catch {
      return []
    }
    return contents.split('\n').filter((line) => line.trim() !== '')
  }

  #fileFor(month: string): string {
    return join(this.#auditRoot, `${month}.jsonl`)
  }
}

/**
 * Whether a file ends on a line boundary — reading one byte, not the file.
 *
 * A month of records is as long as the month was busy, and this is asked on the
 * way to writing one. True for a file that is not there yet: nothing that does
 * not exist is torn.
 */
function endsWhole(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const { size } = fstatSync(fd)
    if (size === 0) return true
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a
  } catch {
    return true
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Read one line back, or null if it is not a record.
 *
 * Checked against what a record is *for*, never against what a total needs: a
 * line that lost `caller` adds up perfectly and answers nothing, and a missing
 * cost would be summed as a Task that was free.
 *
 * The case it is really for is a half-written last line, which must cost the
 * month one record rather than all of them.
 */
function readRecord(line: string): AuditRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record['at'] !== 'string' || typeof record['taskId'] !== 'string') return null
  if (typeof record['caller'] !== 'string') return null
  if (!OUTCOMES.includes(record['outcome'] as TaskOutcome)) return null
  if (!isFigure(record['costUsd'])) return null
  // Absent is a Task, which is what every record written before ADR-0012 is.
  // Present and unrecognised is not readable: a kind this cannot name would be
  // counted as a Task, and the whole reason the field exists is to stop one kind
  // being read as the other.
  if (record['kind'] !== undefined && !KINDS.includes(record['kind'] as AuditKind)) return null
  // Absent is the Pinned Model, which is what every record written before
  // ADR-0014 ran on. Present and not a name is a torn line rather than a record
  // with a hole in it: the one question this field exists to answer is which
  // model spent the shared window, and a line that answers it with a number
  // answers it wrongly.
  if (record['model'] !== undefined && typeof record['model'] !== 'string') return null
  // Absent is *unknown* rather than the Pinned Effort — see the field. Present
  // and not a name is a torn line for `model`'s reason: the question this field
  // answers is what a Turn was asked to think at, and a line answering it with a
  // number answers it wrongly.
  if (record['effort'] !== undefined && typeof record['effort'] !== 'string') return null
  // Absent is a no, which is what every record written before there were Cloud
  // Reaches means. Present and not a boolean is a torn line rather than a record
  // with a hole in it: the one question this field answers is yes or no, and a
  // line that answers it with a number is answering a different question — the
  // count ADR-0015 refused.
  if (record['cloudReach'] !== undefined && typeof record['cloudReach'] !== 'boolean') return null
  // Absent is a no, which is what every record written before there were Document
  // Reaches means, and unreadable for anything that is not a yes or a no — the
  // line above's reasoning, for the field beside it.
  if (record['documentReach'] !== undefined && typeof record['documentReach'] !== 'boolean') {
    return null
  }
  // Absent is no Compaction, which is what every record written before roma
  // could see one says. Present and not readable as one is a torn line rather
  // than a record with a hole in it, for `cloudReach`'s reason: this field is the
  // whole account of why a Task cost several times what its neighbours did, and a
  // line that answers that with a string answers it wrongly.
  if (record['compaction'] !== undefined && !isCompaction(record['compaction'])) return null
  if (!CREDENTIALS.includes(record['credential'] as CredentialKind)) return null
  return record as unknown as AuditRecord
}
