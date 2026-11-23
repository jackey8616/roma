import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnThrough, type RuntimeProcessExit } from './runtime-process.js'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function launcherSaying(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-launch-'))
  dirs.push(dir)
  const path = join(dir, 'roma-launch')
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

const seated = (launcher: string) =>
  spawnThrough(launcher)({
    command: 'true',
    args: [],
    cwd: '/nowhere',
    env: { PATH: '/usr/bin:/bin' },
    seat: { seat: 3, sessionId: '00000000-0000-4000-8000-000000000001' },
  })

const exitOf = (process: ReturnType<typeof seated>): Promise<RuntimeProcessExit> =>
  new Promise((done) => process.onExit(done))

const stderrSaysClosed = (process: ReturnType<typeof seated>): Promise<void> =>
  new Promise((done) =>
    process.onStderr((chunk) => {
      if (chunk.includes('closed')) done()
    }),
  )

const uncaughtWhile = async (run: () => Promise<unknown>): Promise<unknown[]> => {
  const caught: unknown[] = []
  const record = (error: unknown): void => {
    caught.push(error)
  }
  globalThis.process.on('uncaughtException', record)
  try {
    await run()
  } finally {
    globalThis.process.off('uncaughtException', record)
  }
  return caught
}

describe('a write to a Runtime whose stdin has closed [fence:runtime-stdin-error-never-throws]', () => {
  const why =
    'A Runtime can close its stdin before roma sees it exit. The write that lands in between ' +
    'fails with EPIPE, and an unhandled stdin error would end roma and every Session in it; ' +
    'the exit event already tells ClaudeSession and CodexAppServer the Runtime is gone.'

  it('passes without throwing, and the exit still arrives', async () => {
    const process = spawnThrough('/nonexistent/roma-launch')({
      command: 'sh',
      args: ['-c', 'exec 0<&-; echo closed >&2; sleep 0.3'],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
    })
    const exit = exitOf(process)
    const reported: Error[] = []
    process.onError((error) => reported.push(error))

    const caught = await uncaughtWhile(async () => {
      await stderrSaysClosed(process)
      process.write('{}\n')
      await exit
    })

    expect(caught, why).toEqual([])
    expect(reported, why).toEqual([])
    expect(await exit, why).toEqual({ code: 0, signal: null })
  })
})

describe('what the Launcher says on its report pipe', () => {
  it('counts a Seat as started once the Launcher says so, before the Runtime ends [fence:launcher-started-is-read-off-the-report]', async () => {
    const why =
      'ADR-0036: an Enclosure may be written into a Seat only once roma-launch run has ' +
      'prepared it and said started; roma reads that off fd 3 while the Runtime still runs.'
    const process = seated(
      launcherSaying('echo "started 42" >&3; read line; echo "returned seat 03" >&3'),
    )

    const exit = exitOf(process)

    expect(await process.started, why).toBe(true)
    process.write('done\n')
    expect((await exit).seat, why).toEqual({ returned: true })
  })

  it('counts a Seat as never started when the Launcher refuses it', async () => {
    const process = seated(
      launcherSaying('echo "seat 03 still has processes; it was not returned" >&2; exit 77'),
    )

    const exit = exitOf(process)

    expect(await process.started).toBe(false)
    expect((await exit).seat).toMatchObject({ returned: false })
  })
})
