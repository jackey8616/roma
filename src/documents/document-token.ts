import { fileURLToPath } from 'node:url'
import { reasonOf } from '../operator-log.js'
import { askMinter, shimEnvironment } from '../shim-client.js'
import type { ShimResponse } from '../shim-protocol.js'
import { DOCUMENT_SHORTCUT } from './announce.js'

/**
 * The Document Shortcut: one command, one Document Token, nothing to parse.
 *
 * The Cloud Shortcut's contract exactly, for the Cloud Shortcut's reason
 * (ADR-0015 §6, ADR-0022 §4): without it every Task that needs Drive pays the
 * model to write an assertion signer and a token exchange again, out of a Shared
 * Window somebody else is waiting on. A tool invented to save the model's output
 * tokens should not require the model to write a parser to use it.
 *
 * **Not a Credential Shim, and named so that nobody reads it as one.** A Shim
 * occupies the name of a vendor's tool so that the correct path is taken without
 * anybody choosing it. Nothing is being stood in front of here — there is no
 * Drive CLI in the image — so this is `roma-` prefixed and can simply go unused.
 *
 * **It is not a boundary.** The agent has a shell and can write Google's API
 * call itself, which is the long way round working as intended rather than a gap
 * — and it is what makes the Depot's whole verb list open rather than whatever
 * roma thought of. What it cannot do the long way round is obtain a Document
 * Token another way: minting needs the key and the key is the Minter's.
 */

/** What a shell reads when the Shortcut could not produce a token. */
const FAILED = 1
/** What a shell reads when the Shortcut was asked for something it has no idea about. */
const MISUSED = 2

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const unknown = argv.filter((argument) => argument !== '--json')
  if (unknown.length > 0) {
    // Refused rather than ignored. A silently ignored `--jsno` hands back a bare
    // token to something that was about to parse it, and the failure surfaces as
    // unreadable JSON several steps away from the typo that caused it.
    err.write(`${DOCUMENT_SHORTCUT}: ${JSON.stringify(unknown[0])} is not something it takes. ` +
      `Run it with no arguments for the token, or with --json for the token, its expiry and the account.\n`)
    return MISUSED
  }

  let answer: ShimResponse
  try {
    const shim = shimEnvironment(env)
    answer = await askMinter(shim.socketPath, {
      session: shim.sessionId,
      operation: 'get',
      credential: 'documents',
      // Null, and there is nothing to put here. A Document Token reaches the
      // whole Document Reach, so unlike `git` naming a repository there is no
      // destination to announce — and asking the agent to declare one would
      // record an unverifiable self-report (ADR-0015 §10, ADR-0022 §9).
      path: null,
    })
  } catch (error) {
    err.write(`${DOCUMENT_SHORTCUT}: roma could not be reached for a credential: ${reasonOf(error)}\n`)
    return FAILED
  }

  const { token, expiresAt, account } = answer
  if (token === null) {
    // roma's own sentence, passed through rather than paraphrased. It is the
    // difference between "this deployment has no Document Reach" and "the key
    // roma has stopped working", and the agent has to be able to relay either.
    err.write(`${DOCUMENT_SHORTCUT}: ${answer.reason ?? 'roma gave no reason.'}\n`)
    return FAILED
  }

  // The bare form is the common one and is a one-liner —
  // `curl -H "Authorization: Bearer $(roma-document-token)"` — with nothing to
  // parse. The trailing newline is what every command writes and what `$(…)`
  // strips.
  out.write(
    argv.includes('--json')
      ? `${JSON.stringify({
          token,
          // ISO-8601 rather than epoch milliseconds, because this is read by a
          // model and by a person before it is read by a program.
          expiresAt: expiresAt === undefined ? null : new Date(expiresAt).toISOString(),
          account: account ?? null,
        })}\n`
      : `${token}\n`,
  )
  return 0
}

// Run only when this file is the program.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
