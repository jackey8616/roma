import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { credentialFor, shimEnvironment } from './shim-client.js'
import { MINTER_SOCKET_VAR, SESSION_ID_VAR, socketPathIn } from './shim-protocol.js'

let dirs: string[] = []
let servers: Server[] = []

afterEach(async () => {
  for (const server of servers) await new Promise((closed) => server.close(closed))
  servers = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-shim-client-'))
  dirs.push(dir)
  return dir
}

/** Something on the socket that answers every request with `reply`, then hangs up. */
async function answering(reply: string): Promise<string> {
  const socketPath = socketPathIn(directory())
  const server = createServer((socket) => {
    socket.on('error', () => {})
    socket.once('data', () => socket.end(reply, () => socket.destroy()))
  })
  servers.push(server)
  await new Promise<void>((listening) => server.listen(socketPath, listening))
  return socketPath
}

const NAMED = { [MINTER_SOCKET_VAR]: '/run/roma/minter.sock', [SESSION_ID_VAR]: 'a-session' }

describe('finding roma from a Shim', () => {
  it.each([
    [MINTER_SOCKET_VAR, undefined],
    [MINTER_SOCKET_VAR, ''],
    [SESSION_ID_VAR, undefined],
    [SESSION_ID_VAR, ''],
  ])(
    'refuses, naming %s, where it is %j [fence:shim-a-missing-variable-is-said]',
    async (name, value) => {
      const why =
        `A Shim whose ${name} is missing must say so by name rather than default it (#62). A ` +
        'Shim that carried on with no socket or no Session would answer every request with no ' +
        'credential, which presents as authentication failing — and sends somebody to look at ' +
        'the App rather than at the variable that is missing.'
      const env = { ...NAMED, [name]: value }

      expect(() => shimEnvironment(env), why).toThrow(name)
      expect(await credentialFor({ operation: 'get' }, env), why).toEqual({
        token: null,
        complaint: expect.stringContaining(name),
      })
    },
  )
})

describe('asking roma for a credential', () => {
  const why =
    'credentialFor must never reject: every way asking can fail is turned into one sentence ' +
    'for stderr (#62). A Shim that threw would make git or gh fail with a Node stack trace ' +
    'instead of their own account of the command that was run, which is what the agent relays.'

  it.each([
    ['no socket is named', () => Promise.resolve({ [SESSION_ID_VAR]: 'a-session' })],
    [
      'nothing is listening on the socket',
      () =>
        Promise.resolve({
          [MINTER_SOCKET_VAR]: socketPathIn(directory()),
          [SESSION_ID_VAR]: 'a-session',
        }),
    ],
    [
      'roma answers with nonsense',
      async () => ({ [MINTER_SOCKET_VAR]: await answering('not json'), [SESSION_ID_VAR]: 's' }),
    ],
    [
      'roma has no credential to give',
      async () => ({
        [MINTER_SOCKET_VAR]: await answering('{"token":null,"reason":"the key was revoked"}\n'),
        [SESSION_ID_VAR]: 'a-session',
      }),
    ],
  ])(
    'answers with a complaint rather than throwing when %s [fence:shim-credential-for-never-rejects]',
    async (_, environment) => {
      const env = await environment()

      const answered = await credentialFor({ operation: 'get' }, env).then(
        (answer) => answer,
        (error: unknown) => ({ rejected: String(error) }),
      )

      expect(answered, why).toEqual({ token: null, complaint: expect.any(String) })
    },
  )
})

describe('what a Shim complains with', () => {
  it.each([
    ['no socket is named', () => Promise.resolve({ [SESSION_ID_VAR]: 'a-session' })],
    [
      'nothing is listening on the socket',
      () =>
        Promise.resolve({
          [MINTER_SOCKET_VAR]: socketPathIn(directory()),
          [SESSION_ID_VAR]: 'a-session',
        }),
    ],
    [
      'roma has no credential to give',
      async () => ({
        [MINTER_SOCKET_VAR]: await answering('{"token":null,"reason":"the key was revoked"}\n'),
        [SESSION_ID_VAR]: 'a-session',
      }),
    ],
  ])('names no forge when %s [fence:shim-complaint-names-no-forge]', async (_, environment) => {
    const { complaint } = await credentialFor({ operation: 'get' }, await environment())

    expect(
      complaint,
      'The complaint credentialFor writes is the Core speaking, and the Core may not know which ' +
        'forge roma mints against (ADR-0008: GitHub lives in src/github/ behind a narrow port). ' +
        "The tool's own failure beside it on stderr already says which forge it was.",
    ).not.toMatch(/github|gitlab|\bgh\b|forge/i)
  })
})
