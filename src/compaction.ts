/**
 * How seriously roma takes a failed Compaction. Judges only the Compaction
 * nobody asked for: it reads the *code* the automatic path sends, while a
 * `/compact` somebody typed carries a sentence in the same field and its
 * failure is that Relay's own answer.
 *
 * Enforced by `fence:stream-unknown-compaction-code-is-unexplained`.
 */
export type CompactionSeverity =
  /** Nothing happened that anybody needs to know about; the Turn answers. */
  | 'benign'
  /** The Session's context cannot be reduced, so it will not serve another Turn. */
  | 'unreducible'
  /** roma cannot say what it means for the Session: the operator hears, the Caller does not. */
  | 'unexplained'

const BENIGN: readonly string[] = ['too_few_groups', 'aborted']

const UNREDUCIBLE: readonly string[] = ['exhausted', 'media_unstrippable']

/** What roma should do about one failed Compaction, from its code. No code is `unexplained`. */
export function severityOf(code: string | null): CompactionSeverity {
  if (code === null) return 'unexplained'
  if (BENIGN.includes(code)) return 'benign'
  if (UNREDUCIBLE.includes(code)) return 'unreducible'
  return 'unexplained'
}
