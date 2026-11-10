export type CompactionSeverity = 'benign' | 'unreducible' | 'unexplained'

const BENIGN: readonly string[] = ['too_few_groups', 'aborted']

const UNREDUCIBLE: readonly string[] = ['exhausted', 'media_unstrippable']

const MANUAL_BENIGN: readonly string[] = ['Not enough messages to compact.']

export function severityOf(code: string | null): CompactionSeverity {
  if (code === null) return 'unexplained'
  if (BENIGN.includes(code)) return 'benign'
  if (UNREDUCIBLE.includes(code)) return 'unreducible'
  return 'unexplained'
}

export function manualSeverityOf(
  sentence: string | null,
): Exclude<CompactionSeverity, 'unreducible'> {
  if (sentence !== null && MANUAL_BENIGN.includes(sentence)) return 'benign'
  return 'unexplained'
}
