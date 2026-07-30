import { fileURLToPath } from 'node:url'
import { credentialFor } from '../shim-client.js'

/**
 * The `git` half of the Credential Shim: a git credential helper that holds
 * nothing.
 *
 * git's protocol, as it is actually spoken: the helper is run as
 * `helper <operation>`, is given `key=value` lines on stdin terminated by a
 * blank line or EOF, and answers `get` by printing `key=value` lines of its own.
 * Three operations exist and roma treats them as three different things:
 *
 * - **`get`** is answered with `username=x-access-token` and an Installation
 *   Token, which is GitHub's spelling for "this credential is an App's".
 * - **`erase`** is git saying the credential it was given was rejected. It hands
 *   the credential back, which is roma's only signal that a token it believes in
 *   has stopped working. Measured: git 2.43.0 calls a helper twice on an
 *   authentication failure, the second time with `erase` and the dead password
 *   (ADR-0008's amendment).
 * - **`store`** is answered by doing nothing at all. roma has nowhere to store a
 *   credential and wants none: the whole design is that nothing outlives the
 *   operation that needed it.
 *
 * **This is not a boundary against the agent.** The agent has a shell under
 * `bypassPermissions` and can run `git credential fill`, or talk to the socket
 * itself. What this buys is freshness against the one-hour clock, and keeping
 * the token out of any process environment or file — where `env` or a stack
 * trace would write it into a Transcript roma has promised never to delete.
 */

/** GitHub's username for an Installation Token used as a password. */
const USERNAME = 'x-access-token'

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const operation = argv[0] ?? ''
  // Answered before anything else is even read. A `store` that reached the
  // socket would be roma being told a secret it has just handed out, which is
  // noise at best.
  if (operation === 'store') return 0
  if (operation !== 'get' && operation !== 'erase') return 0

  const fields = readFields(await readAll(input))
  const answer = await credentialFor(
    {
      operation,
      // What git named it is reaching for, where `credential.useHttpPath` made
      // it say. Passed on rather than acted on here — the Shim decides nothing.
      path: fields.get('path') ?? null,
      // On `erase`, the credential git is handing back as rejected.
      token: fields.get('password') ?? null,
    },
    env,
  )

  // On stderr rather than swallowed, and never on stdout: git parses stdout as
  // the answer, and a sentence in there would be read as a credential field.
  // git will report authentication failed in its own words; this is why.
  if (answer.complaint !== null) err.write(`${answer.complaint}\n`)
  if (operation === 'erase' || answer.token === null) return 0

  out.write(`username=${USERNAME}\npassword=${answer.token}\n`)
  return 0
}

/**
 * git's input: `key=value` per line, ending at a blank line or at EOF.
 *
 * Repeated keys — `wwwauth[]` arrives more than once — keep the last, which is
 * enough for the two fields roma reads and avoids inventing a shape for the
 * ones it does not.
 */
function readFields(body: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of body.split('\n')) {
    if (line === '') break
    const at = line.indexOf('=')
    if (at === -1) continue
    fields.set(line.slice(0, at), line.slice(at + 1))
  }
  return fields
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  input.setEncoding('utf8')
  let body = ''
  for await (const chunk of input) body += chunk as string
  return body
}

// Run only when this file is the program. Imported — by a test — it defines
// `main` and reads nothing.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
