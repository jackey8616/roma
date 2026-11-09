import { fileURLToPath } from 'node:url'
import { shortcut } from '../shortcut.js'
import { CLOUD_SHORTCUT } from './announce.js'

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  return await shortcut({ name: CLOUD_SHORTCUT, credential: 'cloud', argv, env, out, err })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
