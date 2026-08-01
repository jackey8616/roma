/**
 * Would merging this branch put two ADRs on one number?
 *
 * The I/O half of the collision check — fetch the base branch, find the merge
 * base, list `docs/adr/` in each of the three trees — with every judgement in
 * `scripts/adr-collision.ts`, where it is asserted by the free run.
 * `.github/workflows/ci.yml` runs this on every pull request; it holds no token
 * and writes nothing.
 *
 *   usage: npm run check:adr-collision
 *
 * Three outcomes, and two of them are quiet:
 *
 * - **No shared number.** One log line, exit 0.
 * - **No base branch to compare against**, which is a push to main rather than a
 *   pull request. There is no union to compute — main *is* the union — so this
 *   says which case it was and exits 0.
 * - **A shared number, or a question that could not be asked** — no base ref on
 *   the remote, a clone with no common history to find a merge base in. Exit 1.
 *
 * The last case is one exit code for two things on purpose. A check that swallowed
 * its own failures would pass forever while watching nothing, and the number this
 * exists to catch is one that is invisible in both trees it is being read out of.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collisionMessage, collisionsOnMerge } from './adr-collision.js'

/** Where the ADRs are, which is the only directory this reads. */
const ADR_DIRECTORY = 'docs/adr'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  main()
} catch (error) {
  // The message alone, not a stack. Every throw on the way here was written to say
  // what could not be established, and a workflow log is where it gets read.
  console.error(`adr collision check failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

function main(): void {
  // Set by GitHub on a `pull_request` event and by nothing else. Absent means
  // there is no branch being merged, which is not a failure and not a pass — the
  // question does not apply.
  const base = process.env.GITHUB_BASE_REF

  if (base === undefined || base === '') {
    console.log('no base branch in the environment — nothing is being merged, so nothing to check')
    return
  }

  // The pull request's own commit rather than the merge commit GitHub composes for
  // the checkout, which already contains the base and would make every collision
  // look like it was on both sides. Locally there is no such commit and `HEAD` is
  // the branch.
  const head = process.env.ADR_HEAD_SHA ?? 'HEAD'

  const baseTip = fetchBaseTip(base)

  const collisions = collisionsOnMerge({
    mergeBase: adrsAt(mergeBaseOf(baseTip, head)),
    base: adrsAt(baseTip),
    head: adrsAt(head),
  })

  if (collisions.length === 0) {
    // A log line, because a run that printed nothing gives a reader no way to tell
    // "checked, clear" from "did not check".
    console.log(`no ADR number is shared between this branch and ${base}`)
    return
  }

  throw new Error(collisionMessage(collisions, base))
}

/**
 * The base branch as the remote has it now, fetched rather than read from a
 * checkout.
 *
 * `FETCH_HEAD` rather than `origin/<base>`: a fork's pull request is checked out
 * with the base repository as `origin`, but which remote-tracking refs exist at all
 * depends on how the checkout was configured, and the answer to this check must not.
 * Fetching says what was compared in the same breath as comparing it.
 */
function fetchBaseTip(base: string): string {
  git(['fetch', '--no-tags', 'origin', base])
  return 'FETCH_HEAD'
}

/**
 * Where the branch was cut from.
 *
 * @throws if the two have no common ancestor to find — which in practice is a
 * shallow clone, since `git` cannot see past the depth it was given and would
 * otherwise report every ADR on the base branch as newly added. That is the
 * failure mode this whole file is shaped around: plausible output, computed from
 * a tree that is not there.
 */
function mergeBaseOf(base: string, head: string): string {
  try {
    return git(['merge-base', base, head])
  } catch {
    throw new Error(
      `no common ancestor of ${base} and ${head}. A shallow clone is the usual cause — ` +
        'the checkout needs `fetch-depth: 0`.',
    )
  }
}

/** The ADR filenames in one tree, without the directory they all share. */
function adrsAt(commit: string): string[] {
  return git(['ls-tree', '--name-only', '-r', commit, '--', ADR_DIRECTORY])
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => path.slice(`${ADR_DIRECTORY}/`.length))
}

/** One `git` command, run from the repository root and read for its output. */
function git(argv: string[]): string {
  // `stderr` inherited rather than captured, so a `git` that explains itself does
  // so in the log rather than into a string nothing prints.
  return execFileSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}
