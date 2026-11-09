export type CompactionSeverity = 'benign' | 'unreducible' | 'unexplained'

const BENIGN: readonly string[] = ['too_few_groups', 'aborted']

const UNREDUCIBLE: readonly string[] = ['exhausted', 'media_unstrippable']

export function severityOf(code: string | null): CompactionSeverity {
  if (code === null) return 'unexplained'
  if (BENIGN.includes(code)) return 'benign'
  if (UNREDUCIBLE.includes(code)) return 'unreducible'
  return 'unexplained'
}
