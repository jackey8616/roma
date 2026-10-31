import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { credentialFor } from '../shim-client.js'
import { realGhPath } from './env-config.js'

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const child: NodeJS.ProcessEnv = { ...env }
  for (const name of TOKEN_VARS) delete child[name]

  const answer = await credentialFor(
    {
      operation: 'get',
      path: null,
    },
    env,
  )

  if (answer.complaint !== null) err.write(`${answer.complaint}\n`)
  if (answer.token !== null) for (const name of TOKEN_VARS) child[name] = answer.token

  return await run(realGhPath(env), argv, child)
}

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
    child.on('exit', (code, signal) => finished(code ?? (signal === null ? 1 : 128)))
  })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
