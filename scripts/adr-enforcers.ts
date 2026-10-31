import { citedIn, unresolved, type Fences } from './fence-names.js'

export interface Adr {
  readonly file: string
  readonly text: string
}

export interface Dangling {
  readonly file: string
  readonly line: number
  readonly name: string
  readonly why: string
}

export function danglingEnforcers(adrs: readonly Adr[], fences: Fences): Dangling[] {
  return adrs.flatMap(({ file, text }) =>
    citedIn(text).flatMap(({ name, index }) => {
      const why = unresolved(name, fences)
      const line = text.slice(0, index).split('\n').length
      return why === null ? [] : [{ file, line, name, why }]
    }),
  )
}

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
