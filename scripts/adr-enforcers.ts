/**
 * Does every check an ADR says enforces it exist?
 *
 * An ADR Decision marked "Enforced by `X`" has handed its authority to X
 * (ADR-0031). If X is renamed or deleted, the ADR goes on claiming enforcement
 * that nothing performs. This is the judgement; `scripts/check-adr-enforcers.ts`
 * is the I/O.
 */

import { ENFORCED_BY, unresolved, type Fences } from './fence-names.js'

/** One ADR, by filename, and its text. */
export interface Adr {
  readonly file: string
  readonly text: string
}

/** A citation in an ADR that names no check. */
export interface Dangling {
  readonly file: string
  readonly line: number
  readonly name: string
  readonly why: string
}

/** Every "Enforced by" in these ADRs that does not resolve. */
export function danglingEnforcers(adrs: readonly Adr[], fences: Fences): Dangling[] {
  return adrs.flatMap(({ file, text }) =>
    [...text.matchAll(ENFORCED_BY)].flatMap((match) => {
      const name = match[1]!
      const why = unresolved(name, fences)
      const line = text.slice(0, match.index).split('\n').length
      return why === null ? [] : [{ file, line, name, why }]
    }),
  )
}

/** The failure a person reads in the CI log. */
export function danglingMessage(dangling: readonly Dangling[]): string {
  const found = dangling.map((d) => `  ${d.file}:${d.line}  ${d.name} — ${d.why}`).join('\n')
  return `An ADR says a check enforces it, and the check does not exist:

${found}

ADR-0031: a Decision marked "Enforced by" has handed its authority to that check,
so a dangling name is a Decision nothing holds any more that still reads as held.
Restore the check, point the ADR at the one that replaced it, or remove the marker
and say in the ADR that the Decision is not enforced.
`
}
