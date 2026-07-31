import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One source file: its path relative to `src/`, and what is in it. */
export interface Source {
  readonly file: string
  readonly source: string
}

/**
 * Every source file under `src/`, tests excluded, read.
 *
 * Two of roma's claims are about the tree rather than about behaviour — the Core
 * never names a Channel, and nothing anywhere provisions — and both are kept by
 * reading the sources and failing on a denylist. This is the reading part, in
 * one place, so that a test policing a claim is the denylist and the reason for
 * it and nothing else.
 *
 * Deliberately unfiltered. Each caller narrows to the files its own claim binds,
 * which differ: the Channel-name rule stops at `src/channels/`, and the
 * provisioning rule does not.
 */
export function sources(): Source[] {
  const src = fileURLToPath(new URL('../../src/', import.meta.url))
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(src, file), 'utf8') }))
}

/**
 * The composition roots, which every containment rule excludes.
 *
 * One per deployment, and today there is one deployment. Excluded for the reason
 * it already names a Channel: assembling roma means saying what it is assembled
 * out of, and something has to import a Minter by the name of the directory it
 * lives in. Named here rather than by pattern, and named *once* rather than
 * per-rule, so that adding a second deployment cannot leave one rule watching a
 * file the others do not.
 */
export const COMPOSITION_ROOTS = [['channels', 'google-chat', 'main.ts'].join(sep)]

/** One composition root, read. */
export function compositionRoot(file = COMPOSITION_ROOTS[0] ?? ''): string {
  return sources().find((source) => source.file === file)?.source ?? ''
}

/**
 * The sources a containment rule binds, split by the directory that owns the
 * knowledge.
 *
 * `inside` is the directory the rule exists to confine knowledge *to*, and
 * every rule needs it as well as `outside` — a denylist that matches nothing
 * anywhere reports containment it is not checking, so each rule asserts that
 * the directory it excludes trips it.
 *
 * Here rather than in each test because there are two of these now — GitHub and
 * the agent's cloud — and the copy that drifts first would be this splitting
 * rather than either denylist. What is deliberately *not* here is the denylists
 * themselves or the reasons for them: those are the whole content of a
 * containment test, and a helper that held them would leave the test a call.
 */
export function containment(directory: string): { inside: Source[]; outside: Source[] } {
  const owns = ({ file }: Source) => file.split(sep).includes(directory)
  const all = sources()
  return {
    inside: all.filter(owns),
    outside: all.filter(
      (source) => !owns(source) && !COMPOSITION_ROOTS.includes(source.file),
    ),
  }
}

/**
 * A file with its comments taken out, so that a claim about it is a claim about
 * what it *does*.
 *
 * The idiom `src/packaging.test.ts` already uses, for its reason: half of these
 * files explain themselves by naming the very thing they must not contain —
 * that the Minter is a port because a REST call cannot be in the Core, that the
 * cloud key is loaded explicitly *because* a resolution chain would end at
 * roma's own identity. Reading the prose as if it were an instruction would make
 * documenting a decision the way to break the test that keeps it.
 *
 * Line comments are recognised only at the start of a line, so that a `//`
 * inside a URL in real code is not mistaken for one.
 */
export function code(source: string): string {
  let inBlock = false
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      if (inBlock) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      return !trimmed.startsWith('//')
    })
    .join('\n')
}
