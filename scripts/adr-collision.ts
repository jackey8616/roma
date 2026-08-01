/**
 * Would merging this branch put two ADRs on one number?
 *
 * `src/adr-numbering.test.ts` reads `docs/adr/` in **one tree**. That is a real
 * question and it answers it correctly, but the number it cannot see is the one
 * that is not in the tree yet: two branches each add `0010-`, each pass alone, and
 * the repeated number exists only in the union — which is main, after both have
 * merged. This is that union, computed before the merge rather than after.
 *
 * Everything that decides *what the answer means* is here — the merged tree, the
 * grouping, the wording of the failure — with the `git` calls in
 * `scripts/check-adr-collision.ts`, because all of it fails the same way. A union
 * computed slightly wrong reports nothing and exits 0, and a green tick on a check
 * named for collisions reads as "no collision". So the judgement is asserted by
 * the free run and the entry point is left with genuinely only I/O.
 *
 * ## What this does not do
 *
 * It narrows the window; it does not close it. It reads main as main is at the
 * moment it runs, and nothing re-runs it when main moves — so two pull requests
 * open at once both pass, and the first to merge makes the second's green stale.
 * That is the exact shape of the near-miss in #76 that this was written for.
 *
 * Closing it needs the branch to be current at the moment of merge, which is
 * GitHub's **"require branches to be up to date before merging"** on the branch
 * protection rule and not something a workflow can do by itself. This repository
 * does not set it, deliberately:
 *
 * - It is all-or-nothing. The middle worth wanting — require it only when the diff
 *   touches `docs/adr/` — cannot be expressed: it is a property of a ruleset's
 *   required status checks, and a ruleset's conditions are branch names rather
 *   than paths. So the choice is between every pull request rebasing whenever main
 *   moves, or none of them.
 * - The price is paid by every pull request and the fault is rare. A shared number
 *   has occurred twice across fifteen ADRs, and a person reading caught it both
 *   times.
 *
 * That decision is why `collisionMessage` says so out loud. A check that looks
 * like it closes a hole and does not is worse than one that admits its limits,
 * because the next person to hit this will trust it.
 */

/**
 * An ADR, by the leading digits of its filename.
 *
 * A file under `docs/adr/` that does not start with digits is not an ADR — a
 * README, say — and is skipped rather than failed, so the directory can hold one
 * without this check having an opinion about it.
 *
 * A second copy of `src/adr-numbering.test.ts`'s rule, and deliberately so rather
 * than an import: that file is a claim about a repository written in the idiom
 * `src/packaging.test.ts` uses, standing on its own and reaching for nothing —
 * which is why `fromRoot` is spelled out in both of them too. The price is that
 * the two definitions have to be kept saying the same thing, because checks that
 * disagreed about what an ADR is would disagree about whether a number was taken.
 */
const NUMBERED = /^(\d+)-/

/** The three trees the merged one is made of, each as bare filenames in `docs/adr/`. */
export interface Trees {
  /** Where the branch was cut from — what it has *not* changed. */
  mergeBase: string[]
  /** The base branch as it is now, which is what the branch would land on. */
  base: string[]
  /** The branch. */
  head: string[]
}

/** One number that more than one document would hold. */
export interface Collision {
  number: number
  /** Documents with this number already on the base branch. */
  onBase: string[]
  /** Documents with this number the branch brings. */
  added: string[]
}

/**
 * Every ADR number that would be shared once this branch merges.
 *
 * The merged tree rather than a comparison of the two: base and head together,
 * less what either side deleted. Deletions matter because a rename is one — an
 * ADR renamed while keeping its number adds no collision, and a check comparing
 * filename sets alone would call the add a collision with the delete it came
 * from. That is the false positive worth spending a third tree on: a check that
 * blocks the first branch with a good reason to do something is a check that gets
 * switched off.
 *
 * Both sides, symmetrically, because the two rename cases fail differently and
 * the second is the worse one. A rename on the *branch* fails the branch that
 * made it, which at least points at its author. A rename on the *base* fails
 * every branch cut before it at once, none of which deleted anything or added a
 * number — and the report would name two real files and a real number while
 * asking for a renumbering that is not the reader's to do.
 *
 * A number two of the branch's *own* documents share is reported too, even though
 * `src/adr-numbering.test.ts` fails on it in the same run. The claim here is about
 * the merged tree, and the merged tree does hold two.
 */
export function collisionsOnMerge({ mergeBase, base, head }: Trees): Collision[] {
  // What each side removed, which is what it had at the merge base and has no
  // longer. Nothing else can be a deletion: a file neither side started with is an
  // addition to whichever side has it.
  const deleted = new Set([
    ...mergeBase.filter((file) => !head.includes(file)),
    ...mergeBase.filter((file) => !base.includes(file)),
  ])

  const merged = [...new Set([...base, ...head])].filter((file) => !deleted.has(file))
  const alreadyOnBase = new Set(base)

  const byNumber = new Map<number, string[]>()

  for (const { file, number } of adrs(merged)) {
    // Keyed on the value rather than the digits, so `9-` and `0009-` collide here
    // the way they would collide in a citation.
    const n = Number(number)
    byNumber.set(n, [...(byNumber.get(n) ?? []), file])
  }

  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([number, files]) => ({
      number,
      onBase: files.filter((file) => alreadyOnBase.has(file)).sort(),
      added: files.filter((file) => !alreadyOnBase.has(file)).sort(),
    }))
    .sort((a, b) => a.number - b.number)
}

/**
 * The failure a person reads in the workflow log, which is the deliverable.
 *
 * Three things, in this order: which number and which documents, what a shared
 * number actually costs, and what this check did not check. The middle one is
 * there because "duplicate ADR number" reads as a naming problem, and renumbering
 * is then a chore somebody does to get the tick back — where the fault is that
 * every citation in the repo resolves to whichever document the reader had in
 * mind, which is what kept the 0006 contradiction invisible. ADR-0007's Status is
 * the account of it.
 *
 * @throws if there is no collision to report. A failure message with nothing in it
 * is this check failing for a reason of its own, and reads as a collision to
 * whoever finds the red run.
 */
export function collisionMessage(collisions: Collision[], base: string): string {
  if (collisions.length === 0) {
    throw new Error('refusing to report a collision that was not found')
  }

  const found = collisions
    .map(({ number, onBase, added }) =>
      [
        `  ${number}`,
        ...onBase.map((file) => `    already on ${base}:  ${file}`),
        ...added.map((file) => `    this branch adds: ${file}`),
      ].join('\n'),
    )
    .join('\n\n')

  return `Merging this branch would put two ADRs on one number:

${found}

That is not a naming problem. Every reference in the repo citing a shared number
resolves to whichever document the reader had in mind, so a contradiction between
the two has nowhere to surface — ADR-0007's Status is the account of the last time
that happened. Renumber the document this branch adds: the filename and the
'# N.' heading inside it together, which src/adr-numbering.test.ts checks agree.

This check narrows the window; it does not close it. It read ${base} as ${base} is
right now, and nothing re-runs it when ${base} moves — so two pull requests open at
once both pass, each green against a ${base} that did not yet hold the other, and the
first to merge makes the second's green stale. Closing that needs "require branches
to be up to date before merging" on the branch protection rule, which this
repository does not set: it cannot be limited to the pull requests that touch
docs/adr/, so it would cost every pull request a rebase whenever ${base} moved. Read a
green run here as "${base} did not hold this number when this ran", and look again if
docs/adr/ has moved since.
`
}

/** The ADRs among some filenames, with the digits that name each one. */
function adrs(files: string[]): { file: string; number: string }[] {
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, number: NUMBERED.exec(file)?.[1] }))
    .filter((adr): adr is { file: string; number: string } => adr.number !== undefined)
}
