import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { credentialFor } from '../shim-client.js'
import { realGhPath } from './env-config.js'

/**
 * The `gh` half of the Credential Shim: mint, hand the token to one child, exec
 * the real thing.
 *
 * `gh` has no notion of a credential helper. It reads `GH_TOKEN`, or a config
 * file it was logged into — a process environment and a file on disk, which are
 * the two things ADR-0008 rejects on the one-hour expiry. So the token is put
 * into the environment of *one* child process, per invocation, and nothing that
 * outlives the command exists anywhere.
 *
 * Per invocation rather than per Session, for the arithmetic that decides
 * everything else here: an environment fixed at Session spawn is stale within
 * the hour, and a Resident Session outliving an hour is ordinary.
 *
 * It is installed in the image under the name `gh`, with the real binary kept
 * somewhere that is not on `PATH`. There is therefore nothing to bypass by
 * accident — and, as with the `git` Shim, nothing to bypass *on purpose* either,
 * because this is not a boundary against the agent. It has a shell.
 *
 * The GitHub MCP server was considered in `gh`'s place and is worse here: its
 * token is an environment variable read once at launch, and an MCP server starts
 * once per Session and stays. That is `GH_TOKEN` at spawn with an extra process
 * in front of it.
 */

/** The names `gh` will take a token from, and therefore the ones roma controls. */
const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const child: NodeJS.ProcessEnv = { ...env }
  // Cleared first, whichever way the mint goes. A stale `GH_TOKEN` inherited
  // from somewhere else would otherwise be what `gh` ran on when roma could not
  // produce one — a credential nobody chose, used silently.
  for (const name of TOKEN_VARS) delete child[name]

  const answer = await credentialFor(
    {
      operation: 'get',
      // `gh` announces no repository: `gh api graphql` and `gh search` have none
      // to announce, and inferring one from argv or the working directory is a
      // guess whose failures surface as unexplained 404s inside somebody's Turn.
      // ADR-0008's amendment is where this decides the whole down-scoping
      // question.
      path: null,
    },
    env,
  )

  // Said out loud, and then `gh` runs anyway — unauthenticated, failing in its
  // own words about the command that was actually attempted. Nothing roma could
  // say instead would be more use than that.
  if (answer.complaint !== null) err.write(`${answer.complaint}\n`)
  if (answer.token !== null) for (const name of TOKEN_VARS) child[name] = answer.token

  return await run(realGhPath(env), argv, child)
}

/** Run the real `gh`, wired straight through, and report what it exited with. */
async function run(
  command: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((finished) => {
    const child = spawn(command, [...argv], { stdio: 'inherit', env })
    child.on('error', (error) => {
      process.stderr.write(`roma could not run ${command}: ${error.message}\n`)
      finished(127)
    })
    // A signalled child is reported the way a shell reports one, so that an
    // interrupted `gh` does not look like a clean exit to whatever ran it.
    child.on('exit', (code, signal) => finished(code ?? (signal === null ? 1 : 128)))
  })
}

// Run only when this file is the program.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
