/**
 * Has the pinned Claude Code fallen behind what npm publishes?
 *
 * The I/O half of the drift check — read the `Dockerfile`, ask the registry, run
 * the `grep` — with every judgement in `scripts/claude-code-drift.ts`, where it is
 * asserted by the free run. `.github/workflows/claude-code-drift.yml` runs this
 * weekly and files the report; this file decides nothing about the tracker and
 * holds no token.
 *
 *   usage: npm run check:claude-code-drift
 *
 * Three outcomes, and only one of them is quiet:
 *
 * - **The versions match.** Nothing is filed, nothing is commented, exit 0.
 * - **They differ.** The report is written to a file and `drift=true` goes to
 *   `GITHUB_OUTPUT`, for the workflow step that opens or updates the issue.
 * - **The question could not be asked** — no `Dockerfile`, an `ARG` that assigns
 *   nothing comparable, a registry lookup that failed, a `grep` that found the
 *   pinned version nowhere. Exit 1, loudly.
 *
 * The third case is the one this file is shaped around: a check that swallowed its
 * own failures would pass forever while watching nothing. ADR-0007 has the rest.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { driftReport, pinnedClaudeCode, publishedClaudeCode } from './claude-code-drift.js'

/**
 * The `latest` dist-tag document, which is the smallest answer that contains the
 * one field this needs — the full packument is megabytes of version history.
 */
const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  await main()
} catch (error) {
  // The message alone, not a stack. Every throw on the way here was written to
  // say what could not be established, and a workflow log is where it gets read.
  console.error(`claude-code drift check failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

async function main(): Promise<void> {
  // No try/catch: a missing Dockerfile is `ENOENT` with the path in it, which is
  // the whole of what needs saying, and it must end the run rather than be
  // treated as "no pin found".
  const pinned = pinnedClaudeCode(readFileSync(join(root, 'Dockerfile'), 'utf8'))
  const published = publishedClaudeCode(await registryDocument())

  if (pinned === published) {
    // The only quiet outcome. A log line, because a run that printed nothing
    // gives a reader no way to tell "checked, current" from "did not check".
    console.log(`the pin and the registry agree on ${pinned} — nothing to report`)
    writeStepOutputs({ drift: 'false' })
    return
  }

  const report = driftReport({ pinned, published, evidence: evidenceFor(pinned) })

  const path = join(process.env.RUNNER_TEMP ?? tmpdir(), 'claude-code-drift.md')
  writeFileSync(path, report.body)

  console.log(`pinned ${pinned}, published ${published} — report written to ${path}`)

  // `title` is a single line by construction: it is built from two version strings
  // `EXACT_VERSION` has already refused newlines in, so it cannot close its own
  // `key=value` and forge a second output.
  writeStepOutputs({ drift: 'true', title: report.title, body_file: path })
}

/** The registry's answer, with a failed lookup ending the run rather than the check. */
async function registryDocument(): Promise<unknown> {
  // A `fetch` that rejects — DNS, TLS, a proxy — throws out of here and is caught
  // above. What needs saying explicitly is the failure that does *not* reject: an
  // error status carrying a JSON body, which `publishedClaudeCode` would also
  // refuse, but with a message about a shape rather than about a 404.
  const response = await fetch(REGISTRY)

  if (!response.ok) {
    throw new Error(`${REGISTRY} answered ${response.status} ${response.statusText}`)
  }

  return await response.json()
}

/**
 * Every file in the working tree that names the pinned version.
 *
 * The command the ticket asked for, because it is the honest list and stays true
 * as the repo moves: a hardcoded one would be a fourth copy of the same claim,
 * out of date the first time a document cites the version and nobody remembers
 * this file exists.
 *
 * `node_modules` and `.git` are excluded as noise, and binary files with them —
 * evidence about a version is prose or code, and "Binary file matches" is not a
 * file anybody re-verifies. `-F` because a version is a fixed string and not a
 * pattern: unescaped, `2.1.220` matches `2X1X220`, and this is the one place the
 * check makes a claim about a file it has not parsed.
 */
function evidenceFor(pinned: string): string[] {
  let found = ''

  try {
    found = execFileSync(
      'grep',
      ['-rlIF', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', pinned, '.'],
      { cwd: root, encoding: 'utf8' },
    )
  } catch (error) {
    // grep exits 1 for "no matches", which is not an error to it and is a
    // contradiction here — the version was just read out of a file in this tree.
    // Returned empty rather than rethrown so that `driftReport` refuses it, which
    // is where that contradiction is written down. Any other status is grep
    // failing at its job and belongs at the top level.
    if ((error as { status?: number }).status !== 1) throw error
  }

  return found
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\.\//, ''))
    .sort()
}

/** Step outputs, when there is a step. Locally there is not, and stdout is the log. */
function writeStepOutputs(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`)
  const path = process.env.GITHUB_OUTPUT

  if (path === undefined) {
    process.stdout.write(lines.join(''))
    return
  }

  appendFileSync(path, lines.join(''))
}
