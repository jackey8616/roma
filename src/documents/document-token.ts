import { fileURLToPath } from 'node:url'
import { shortcut } from '../shortcut.js'
import { DOCUMENT_SHORTCUT } from './announce.js'

/**
 * The Document Shortcut: one command, one Document Token, nothing to parse.
 *
 * What a Shortcut *is* — why it exists, why it is not a Credential Shim, why it
 * is not a boundary — is `shortcut.ts`, which both of roma's Shortcuts are. This
 * file is the Document Reach's half: the name, the credential, and the one thing
 * that is about Drive rather than about Shortcuts.
 *
 * That one thing is what keeping the long way round open *buys* here, which is
 * more than it buys the Cloud Shortcut. The alternative considered and rejected
 * was roma holding the credential and offering a whitelist of verbs over the
 * socket — a genuinely stronger boundary — and what killed it is that every verb
 * roma did not think of would become a wall with nothing behind it: no
 * formatting, no formulas, no second tab, no fixing a typo it just made, each one
 * an image change away (ADR-0022 §4). The destruction that boundary would have
 * prevented is refused by the Drive role instead, which is Google's to enforce
 * and does not need roma in the request path at all.
 */

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  return await shortcut({ name: DOCUMENT_SHORTCUT, credential: 'documents', argv, env, out, err })
}

// Run only when this file is the program.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
