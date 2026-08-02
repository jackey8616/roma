/**
 * What one failed Compaction means, and the only place that judgement is made.
 *
 * `shared-window.ts`'s opposite number, and written after reading how that one
 * went wrong: the rule below is stated as a list of the codes roma has a reason
 * to believe are harmless, and everything else is treated as something an
 * operator should see. The other way round — enumerate the serious ones, assume
 * the rest are fine — is the shape that fails silently on the release that adds
 * a code, which is exactly what "anything that is not `allowed` is spent" did
 * one file over.
 *
 * **This judges the Compaction nobody asked for, and only that one.** The whole
 * file reads a *code*, which is what the automatic path sends; a `/compact`
 * somebody typed carries a **sentence** in the same field on the pinned build —
 * `"Not enough messages to compact."` — so putting it through here would sort
 * the commonest failure of that path into `unexplained` and write an operator
 * line about a Turn that was fine. Reconciled in the Core rather than here, and
 * not by adding sentences to the lists below: a Compaction that failed inside a
 * Relay roma sent is that Relay's own answer, so the Caller gets Claude Code's
 * words and nothing reaches this function (ADR-0018).
 */

/**
 * How seriously roma takes a failed Compaction, in the three answers it has.
 *
 * Three rather than two because roma is told a code and not a consequence, and
 * the two things it can do about one — write to the Operator Log, and speak to
 * the Caller — have different bars. `unexplained` is the answer that keeps the
 * second bar high without keeping anything from the operator.
 */
export type CompactionSeverity =
  /**
   * Nothing happened that anybody needs to know about.
   *
   * The Turn around one of these stays healthy and answers: measured, twice, in
   * `compaction-auto.jsonl` and `compaction-failed.jsonl` — a `too_few_groups`
   * inside a Turn that cost two cents and worked, and another whose Session
   * served the next Turn normally. #98 was written believing a failed Compaction
   * meant a Session that could not serve another Turn; the measurement is what
   * corrected it, and building the issue as written would have told a Caller
   * their thread was full in the middle of a Turn that was fine.
   */
  | 'benign'
  /**
   * The Session's context cannot be reduced, so it will not serve another Turn.
   *
   * The failure #98 was actually about. Every subsequent message to that
   * Conversation fails, roma has a repair — a new Session Generation, which is
   * what `/clear` gives out — and without this nobody knows to reach for it.
   */
  | 'unreducible'
  /**
   * A Compaction failed and roma cannot say what it means for the Session.
   *
   * The operator hears about it; the Caller does not. Telling somebody their
   * thread is full and to throw it away is a sentence roma has to be able to
   * stand behind, and a code it has never seen is not that — ADR-0010 sets a high
   * bar for an unprompted message in a Conversation, and a false alarm on a Turn
   * that worked is exactly what that bar is for.
   */
  | 'unexplained'

/**
 * The codes roma treats as harmless, and the reason each one is on the list.
 *
 * Read off a single switch in the pinned build (2.1.220, ADR-0007), quoted in
 * #98's second comment, which maps every code to what Claude Code does with it.
 * The five it names are `too_few_groups`, `aborted`, `exhausted`,
 * `media_unstrippable` and `error`, and they split two-three along a line the
 * build draws for itself: the two below throw a plain `Error`, and the other
 * three throw the class reserved for what it shows a user. Two independent
 * signals agreeing is why this split is worth more than either half of it — and
 * roma still has to enumerate, because only the code reaches stdout.
 *
 * **A person's judgement about one build**, like the Relay list, and re-applied
 * when the pin moves. What a new release can do to it is add a code, and an added
 * code lands in `unexplained` — the operator sees it, nobody is told a wrong
 * story about their thread, and somebody decides which list it belongs on.
 */
const BENIGN: readonly string[] = [
  // Not enough conversation to summarise yet. Benign, and on the evidence the
  // common one — both captures roma holds are this code, and on the manual path
  // it is likely to be the most common failure there is, since somebody typing
  // `/compact` into a short thread is exactly this.
  'too_few_groups',
  // Somebody stopped it. Nothing has gone wrong that they do not already know
  // about, and the reply they are owed is the one `/stop` produces.
  'aborted',
]

/**
 * The codes that mean the context cannot be reduced below the limit.
 *
 * Read off the same switch and **not measured** — provoking either means filling
 * a real context, which is the expensive path #98 designed its whole measurement
 * to avoid, and the reward would be confirming an explicit `case`. Recorded as
 * read rather than measured, here rather than in a commit message, because that
 * is the one thing a later reader cannot recover.
 *
 * Both are the same fact to a Caller — this Session will not take another
 * message — and both have the same remedy, which is why they share an answer
 * rather than each getting one.
 */
const UNREDUCIBLE: readonly string[] = [
  // "conversation could not be reduced below the context limit".
  'exhausted',
  // "attached media exceeds size limits" — unreducible for a different reason
  // and with the same consequence.
  'media_unstrippable',
]

/**
 * What roma should do about one failed Compaction, from its code.
 *
 * `error` is deliberately on neither list. It is the build's own catch-all —
 * `Error during compaction: ${detail || "unknown error"}` — so it says that
 * something went wrong and nothing about whether the Session survived it, which
 * is `unexplained` exactly. A missing code is the same answer for the same
 * reason.
 */
export function severityOf(code: string | null): CompactionSeverity {
  if (code === null) return 'unexplained'
  if (BENIGN.includes(code)) return 'benign'
  if (UNREDUCIBLE.includes(code)) return 'unreducible'
  return 'unexplained'
}
