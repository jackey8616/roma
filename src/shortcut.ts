import { reasonOf } from './operator-log.js'
import { askMinter, shimEnvironment } from './shim-client.js'
import type { CredentialWanted, ShimResponse } from './shim-protocol.js'

/**
 * A Shortcut: one command, one credential, nothing to parse.
 *
 * The shape CONTEXT.md's Cloud Shortcut and Document Shortcut both have, in the
 * place ADR-0020 put `Reach` — a name for the idea rather than for either
 * instance. The two programs were written twice and were identical apart from
 * the command's name and which credential it asks for, which is a second place
 * for the contract to drift and would have been a third at the next Reach.
 *
 * **Shared here and not in either directory**, because there is nothing about a
 * provider in it: it asks roma's own socket for a credential roma already named
 * in `CredentialWanted`, and it constructs nothing. That is the line ADR-0022
 * draws for the Minters, which are duplicated for exactly the reason this is not
 * — nothing shared may make it possible to construct a Google credential outside
 * a directory a containment rule binds, and asking for one over a Unix socket is
 * not constructing one. `shim-client.ts` is the same call made once for the two
 * Credential Shims, and is the precedent.
 *
 * What each Shortcut keeps is its own program, its own name in the image, and
 * its own reasoning about the product it does *not* stand in front of. Each also
 * keeps its own end-to-end test, which is not the duplication above: they are two
 * binaries in the image, and what a shell observes of one is not evidence about
 * the other.
 *
 * Its purpose is money. Without it, every Task needing a provider pays the model
 * to write an assertion signer and a token exchange again, and those Turns are
 * Shared Window quota with somebody waiting at the other end (ADR-0015 §6).
 *
 * **Not a Credential Shim.** A Shim occupies the name of a vendor's tool so that
 * the correct path is taken without anybody choosing it. A Shortcut stands in
 * front of nothing, is `roma-` prefixed, and can simply go unused.
 *
 * **It is not a boundary.** The agent has a shell and can write the provider's
 * API call itself, which is the long way round working as intended rather than a
 * gap. What it cannot do the long way round is obtain the credential another
 * way: minting needs the key and the key is the Minter's.
 */

/** What a shell reads when a Shortcut could not produce a token. */
const FAILED = 1
/** What a shell reads when a Shortcut was asked for something it has no idea about. */
const MISUSED = 2

export interface ShortcutOptions {
  /** The name the image installs it under, for anything it has to say. */
  readonly name: string
  /** Which credential it asks roma for. */
  readonly credential: CredentialWanted
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
  readonly out: NodeJS.WritableStream
  readonly err: NodeJS.WritableStream
}

/** Run one Shortcut, and answer with what a shell should exit on. */
export async function shortcut({
  name,
  credential,
  argv,
  env,
  out,
  err,
}: ShortcutOptions): Promise<number> {
  const unknown = argv.filter((argument) => argument !== '--json')
  if (unknown.length > 0) {
    // Refused rather than ignored. A silently ignored `--jsno` hands back a bare
    // token to something that was about to parse it, and the failure surfaces as
    // unreadable JSON several steps away from the typo that caused it.
    err.write(`${name}: ${JSON.stringify(unknown[0])} is not something it takes. ` +
      `Run it with no arguments for the token, or with --json for the token, its expiry and the account.\n`)
    return MISUSED
  }

  let answer: ShimResponse
  try {
    const shim = shimEnvironment(env)
    answer = await askMinter(shim.socketPath, {
      session: shim.sessionId,
      operation: 'get',
      credential,
      // Null, and there is nothing to put here. Either token reaches the whole of
      // its own Reach, so unlike `git` naming a repository there is no
      // destination to announce — and asking the agent to declare one would
      // record an unverifiable self-report (ADR-0015 §10, ADR-0022 §9).
      path: null,
    })
  } catch (error) {
    err.write(`${name}: roma could not be reached for a credential: ${reasonOf(error)}\n`)
    return FAILED
  }

  const { token, expiresAt, account } = answer
  if (token === null) {
    // roma's own sentence, passed through rather than paraphrased. It is the
    // difference between "this deployment has no such Reach" and "the key roma
    // has stopped working", and the agent has to be able to relay either.
    err.write(`${name}: ${answer.reason ?? 'roma gave no reason.'}\n`)
    return FAILED
  }

  // The bare form is the common one and is a one-liner —
  // `curl -H "Authorization: Bearer $(roma-…-token)"` — with nothing to parse,
  // because a tool invented to save the model's output tokens should not require
  // the model to write a parser to use it. The trailing newline is what every
  // command writes and what `$(…)` strips.
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
