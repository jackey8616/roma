import { fileURLToPath } from 'node:url'
import { shortcut } from '../shortcut.js'
import { CLOUD_SHORTCUT } from './announce.js'

/**
 * The Cloud Shortcut: one command, one Cloud Token, nothing to parse.
 *
 * What a Shortcut *is* — why it exists, why it is not a Credential Shim, why it
 * is not a boundary, and why it does not have to be complete — is `shortcut.ts`,
 * which both of roma's Shortcuts are. This file is the Cloud Reach's half: the
 * name, the credential, and the one thing that is genuinely about the cloud.
 *
 * That one thing is what the long way round *is* here. There is no cloud CLI in
 * the image and none is coming (ADR-0015 §1), so where this does not go far
 * enough the agent writes the call against Google's own REST API, with what is
 * already in the image because roma is a Node program. That is a use of it
 * working as intended rather than a gap in it.
 */

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  return await shortcut({ name: CLOUD_SHORTCUT, credential: 'cloud', argv, env, out, err })
}

// Run only when this file is the program.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
