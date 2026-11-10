import { fileURLToPath } from 'node:url'
import { credentialFor } from '../shim-client.js'

const USERNAME = 'x-access-token'

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  input: NodeJS.ReadableStream = process.stdin,
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const operation = argv[0] ?? ''
  if (operation === 'store') return 0
  if (operation !== 'get' && operation !== 'erase') return 0

  const fields = readFields(await readAll(input))
  const answer = await credentialFor(
    {
      operation,
      path: fields.get('path') ?? null,
      token: fields.get('password') ?? null,
    },
    env,
  )

  if (answer.complaint !== null) err.write(`${answer.complaint}\n`)
  if (operation === 'erase' || answer.token === null) return 0

  out.write(`username=${USERNAME}\npassword=${answer.token}\n`)
  return 0
}

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

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main()
}
