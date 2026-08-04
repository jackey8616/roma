import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Two ADRs may not share a number, and a file may not disagree with its own
 * heading.
 *
 * Written in the idiom `src/packaging.test.ts` uses — read the files, fail on
 * what must not be in them — because this is a claim about a repository rather
 * than about behaviour.
 *
 * It exists because the failure happened. `0006-a-container-image-pinned-to-one-claude-code.md`
 * was published forty-one minutes after `0006-the-transcript-is-not-romas-to-delete.md`
 * and took the same number, and the two disagreed about whether the directory
 * holding the Transcript is durable or disposable. Sharing a number is what kept
 * that invisible: every reference in the repo read "ADR-0006" and resolved to
 * whichever document the reader had in mind, so the contradiction had nowhere to
 * surface. It was found by reading a ticket. ADR-0007's Status is the account of
 * it.
 *
 * The heading check is here for the fix rather than for the original fault:
 * renumbering means editing a filename and an `# N.` heading, and doing one
 * without the other is the obvious next version of the same mistake.
 *
 * Deliberately only these two. A rule that also policed the date format, or
 * demanded a Status section, would block the first ADR that had a reason not to
 * comply and be switched off — which is the argument `src/transcript-lifetime.test.ts`
 * makes for its own narrowness. A repeated number is a fault that has occurred
 * once and cost something; the rest is speculation.
 */

const HEADING = /^#\s+(\d+)\.\s/m

describe('every ADR has its own number', () => {
  it('gives no number to two files', () => {
    const byNumber = new Map<number, string[]>()

    // Keyed on the value rather than the digits, so `6-` and `0006-` collide
    // here the way they would collide in a citation.
    for (const { file, number } of adrs()) {
      const n = Number(number)
      byNumber.set(n, [...(byNumber.get(n) ?? []), file])
    }

    const shared = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${number}: ${files.join(', ')}`)

    expect(shared).toEqual([])
  })

  it('numbers each file the same way in its name and in its heading', () => {
    const disagreements = adrs()
      .map(({ file, number, source }) => {
        const heading = HEADING.exec(source)?.[1]

        return heading === undefined
          ? `${file}: no '# N.' heading`
          : Number(heading) === Number(number)
            ? undefined
            : `${file}: heading says ${heading}`
      })
      .filter((problem) => problem !== undefined)

    expect(disagreements).toEqual([])
  })
})

/**
 * Every ADR, by the leading digits of its filename.
 *
 * A file under `docs/adr/` that does not start with digits is not an ADR — a
 * README, say — and is skipped rather than failed, so the directory can hold
 * one without this test having an opinion about it.
 */
function adrs(): { file: string; number: string; source: string }[] {
  const path = fromRoot('docs/adr')

  return readdirSync(path)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, number: /^(\d+)-/.exec(file)?.[1] }))
    .filter((adr): adr is { file: string; number: string } => adr.number !== undefined)
    .map((adr) => ({ ...adr, source: readFileSync(join(path, adr.file), 'utf8') }))
}

function fromRoot(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}
