/**
 * Which models does the pinned Claude Code strip the effort from?
 *
 * The I/O half of the Effort Matrix extractor — find the bundle, read it, print
 * the report — with every judgement in `scripts/claude-code-effort-matrix.ts`,
 * where it is asserted by the free run. `claude-code-drift.ts` and this file are
 * split for the same reason and it applies harder here: a reading of a minified
 * binary that quietly opens its window too wide produces a plausible table and
 * says nothing about being wrong. ADR-0016 records that happening.
 *
 *   usage: npm run check:claude-code-effort-matrix [-- <path to the claude bundle>]
 *
 * **Nothing consumes this.** No CI job runs it, nothing fails on it, and
 * `EFFORT_MATRIX` in `src/effort-menu.ts` is a constant a person writes after
 * reading the output. It is run when the ADR-0007 pin moves, by hand, alongside
 * the rest of the re-verification `claude-code-drift.ts` reports the size of.
 *
 * Two outcomes, and neither of them is quiet:
 *
 * - **The gates were found.** The report goes to stdout, for a person to read
 *   against the constant. Exit 0.
 * - **They were not** — no bundle at the path, a flag passed nowhere, call sites
 *   spread across functions, braces that do not balance. Exit 1, loudly. A build
 *   whose shape has moved is the thing worth being told about; coping with it
 *   silently is how an extractor comes to watch nothing.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { MENU } from '../src/model-menu.js'
import { effortMatrix, matrixReport } from './claude-code-effort-matrix.js'

try {
  main()
} catch (error) {
  // The message alone, not a stack. Every throw on the way here was written to
  // say what could not be established.
  console.error(
    `claude-code effort matrix failed: ${error instanceof Error ? error.message : error}`,
  )
  process.exit(1)
}

function main(): void {
  const bundle = process.argv[2] ?? locateClaude()
  console.error(`reading ${bundle}`)
  // `latin1` rather than `utf8`, and it matters: the shipped `claude` is a
  // single-file executable with the JavaScript embedded in it, so most of the
  // file is not text at all. Decoded as UTF-8 the invalid sequences become
  // replacement characters and every offset after one shifts — which would move
  // the brace balancing off by however many bytes were mangled. One byte, one
  // character is what keeps an index into this string an index into the file.
  const source = readFileSync(bundle, 'latin1')
  // roma's own Menu, because that is the question the Matrix answers: which
  // models a Session roma serves takes an effort on. A model no Caller can reach
  // is not one roma has anything to record about.
  const { rows, gates } = effortMatrix(source, Object.values(MENU))
  console.log(matrixReport(rows, gates))
}

/**
 * Where `claude` is, according to the shell that would run it.
 *
 * Resolved rather than assumed, because there is no one path: the container
 * image installs it one way, a developer's machine another, and this is run by
 * hand in both. A path can always be passed instead.
 *
 * Deliberately not `npm root` or a `node_modules` lookup — roma does not depend
 * on `@anthropic-ai/claude-code` as a package, it runs whatever `claude` the
 * image pinned, and the pin is the thing being read.
 *
 * @throws if nothing on `PATH` answers to the name, which is the same failure as
 * roma not being able to spawn a Session at all.
 */
function locateClaude(): string {
  try {
    // `-f` so a symlink resolves to the file the bundle is actually in: the
    // usual install puts a small shim on `PATH`, and reading that would find no
    // gates and report a moved build.
    const onPath = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
    return execFileSync('readlink', ['-f', onPath], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      'no `claude` on PATH, and no bundle path given — pass one as an argument: ' +
        'npm run check:claude-code-effort-matrix -- /path/to/claude',
    )
  }
}
