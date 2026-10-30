/**
 * What one failed Compaction means, and the only place that judgement is made.
 *
 * The codes roma believes harmless are listed, and everything else is something
 * an operator should see. Enforced by `fence:stream-unknown-compaction-code-is-unexplained`.
 *
 * **This judges the Compaction nobody asked for, and only that one.** It reads
 * the *code* the automatic path sends; a `/compact` somebody typed carries a
 * **sentence** in the same field, and its failure is that Relay's own answer
 * (ADR-0018).
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

const BENIGN: readonly string[] = ['too_few_groups', 'aborted']

const UNREDUCIBLE: readonly string[] = ['exhausted', 'media_unstrippable']

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
