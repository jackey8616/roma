const NUMBERED = /^(\d+)-/

export interface Trees {
  mergeBase: string[]
  base: string[]
  head: string[]
}

export interface Collision {
  number: number
  onBase: string[]
  added: string[]
}

export function collisionsOnMerge({ mergeBase, base, head }: Trees): Collision[] {
  const deleted = new Set([
    ...mergeBase.filter((file) => !head.includes(file)),
    ...mergeBase.filter((file) => !base.includes(file)),
  ])

  const merged = [...new Set([...base, ...head])].filter((file) => !deleted.has(file))
  const alreadyOnBase = new Set(base)

  const byNumber = new Map<number, string[]>()

  for (const { file, number } of adrs(merged)) {
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

function adrs(files: string[]): { file: string; number: string }[] {
  return files
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, number: NUMBERED.exec(file)?.[1] }))
    .filter((adr): adr is { file: string; number: string } => adr.number !== undefined)
}
