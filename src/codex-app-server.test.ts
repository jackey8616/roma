import { describe, expect, it, vi } from 'vitest'
import { CodexAppServer, CodexAppServerLost, CodexRpcError } from './codex-app-server.js'
import { FakeClaude, flush, type FakeClaudeProcess } from '../test/support/fake-claude.js'

// Seam 1 for the Codex harness: the wire, against a fake process that frames
// bytes rather than events. Every reply below is shaped the way the pinned
// build's own schema says it is (`codex app-server generate-ts`, 0.165.0).

function harness(): { server: CodexAppServer; fake: FakeClaude; proc: () => FakeClaudeProcess } {
  const fake = new FakeClaude()
  const server = new CodexAppServer({
    codexHome: '/var/lib/roma/codex',
    cwd: '/tmp/probe',
    inherit: { HOME: '/home/node', CODEX_HOME: '/somewhere/else' },
    spawn: fake.spawn,
  })
  return { server, fake, proc: () => fake.process }
}

function reply(proc: FakeClaudeProcess, id: number, result: unknown): void {
  proc.emitStdout(`${JSON.stringify({ id, result })}\n`)
}

function notify(proc: FakeClaudeProcess, method: string, params: unknown): void {
  proc.emitStdout(`${JSON.stringify({ method, params })}\n`)
}

describe('spawning', () => {
  it('runs `codex app-server` under the CODEX_HOME it was given, over any inherited one', () => {
    const { fake } = harness()
    expect(fake.lastSpawn.command).toBe('codex')
    expect(fake.lastSpawn.args).toEqual(['app-server'])
    expect(fake.lastSpawn.env).toEqual({ HOME: '/home/node', CODEX_HOME: '/var/lib/roma/codex' })
  })
})

describe('the handshake', () => {
  it('sends initialize, then the initialized notification once it is answered', async () => {
    const { server, proc } = harness()
    const initialized = server.initialize('0.9.0')
    await flush()

    expect(proc().sent).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'roma', title: null, version: '0.9.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      },
    ])

    reply(proc(), 1, {
      userAgent: 'roma/0.165.0',
      codexHome: '/var/lib/roma/codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    })

    await expect(initialized).resolves.toEqual({
      userAgent: 'roma/0.165.0',
      codexHome: '/var/lib/roma/codex',
    })
    expect(proc().sent.at(-1)).toEqual({ method: 'initialized' })
  })

  it('reassembles a reply split across chunks', async () => {
    const { server, proc } = harness()
    const initialized = server.initialize('0.9.0')
    await flush()

    const line = `${JSON.stringify({ id: 1, result: { userAgent: 'u', codexHome: '/h' } })}\n`
    proc().emitStdout(line.slice(0, 9))
    proc().emitStdout(line.slice(9))

    await expect(initialized).resolves.toEqual({ userAgent: 'u', codexHome: '/h' })
  })

  it('rejects with the server’s own error', async () => {
    const { server, proc } = harness()
    const initialized = server.initialize('0.9.0')
    await flush()

    proc().emitStdout(`${JSON.stringify({ id: 1, error: { code: -32600, message: 'nope' } })}\n`)

    await expect(initialized).rejects.toBeInstanceOf(CodexRpcError)
    await expect(initialized).rejects.toThrow('initialize failed (-32600): nope')
  })
})

describe('a thread', () => {
  it('starts on the model it is asked for and reports what the server says it started on', async () => {
    const { server, proc } = harness()
    const thread = server.startThread({ model: 'gpt-5.6-sol', cwd: '/work/s1' })
    await flush()

    expect(proc().sent).toEqual([
      {
        id: 1,
        method: 'thread/start',
        params: { model: 'gpt-5.6-sol', cwd: '/work/s1', approvalPolicy: 'never' },
      },
    ])

    reply(proc(), 1, {
      thread: { id: 'th-1' },
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
    })

    await expect(thread).resolves.toEqual({
      threadId: 'th-1',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    })
  })

  it('reports a null effort as none, and refuses any other non-string', async () => {
    const { server, proc } = harness()
    const none = server.startThread({ model: 'gpt-5.6-sol', cwd: '/w' })
    const odd = server.startThread({ model: 'gpt-5.6-sol', cwd: '/w' })
    await flush()

    reply(proc(), 1, { thread: { id: 'th-1' }, model: 'gpt-5.6-sol', reasoningEffort: null })
    reply(proc(), 2, { thread: { id: 'th-2' }, model: 'gpt-5.6-sol', reasoningEffort: 3 })

    await expect(none).resolves.toMatchObject({ reasoningEffort: null })
    await expect(odd).rejects.toThrow('without a string reasoningEffort')
  })
})

describe('a Turn', () => {
  async function started(effort?: string): Promise<{
    server: CodexAppServer
    turn: ReturnType<CodexAppServer['runTurn']>
    proc: FakeClaudeProcess
  }> {
    const { server, proc } = harness()
    const turn = server.runTurn({
      threadId: 'th-1',
      text: 'Reply PING',
      ...(effort === undefined ? {} : { effort }),
    })
    await flush()
    reply(proc(), 1, { turn: { id: 'tu-1', status: 'inProgress', items: [] } })
    await flush()
    return { server, turn, proc: proc() }
  }

  it('refuses a second Turn while one is running', async () => {
    const { server } = await started()
    await expect(server.runTurn({ threadId: 'th-1', text: 'again' })).rejects.toThrow(
      'a Turn is already running',
    )
  })

  it('sends the text as one input, and the effort only where one is given', async () => {
    const { proc } = await started()
    expect(proc.sent[0]).toEqual({
      id: 1,
      method: 'turn/start',
      params: {
        threadId: 'th-1',
        input: [{ type: 'text', text: 'Reply PING', text_elements: [] }],
      },
    })

    const withEffort = await started('high')
    expect(withEffort.proc.sent[0]?.['params']).toMatchObject({ effort: 'high' })
  })

  it('completes with the agent’s messages and the last usage reading for its thread', async () => {
    const { turn, proc } = await started()

    notify(proc, 'item/completed', {
      threadId: 'th-1',
      turnId: 'tu-1',
      item: { type: 'reasoning', id: 'r1' },
    })
    notify(proc, 'item/completed', {
      threadId: 'th-1',
      turnId: 'tu-1',
      item: { type: 'agentMessage', id: 'm1', text: 'PING' },
    })
    // Another thread's traffic on the same process is not this Turn's.
    notify(proc, 'item/completed', {
      threadId: 'th-2',
      turnId: 'tu-9',
      item: { type: 'agentMessage', id: 'm9', text: 'not mine' },
    })
    const breakdown = {
      totalTokens: 120,
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 8,
    }
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'th-1',
      turnId: 'tu-1',
      tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 272000 },
    })
    notify(proc, 'turn/completed', {
      threadId: 'th-1',
      turn: { id: 'tu-1', status: 'completed', items: [], error: null },
    })

    await expect(turn).resolves.toEqual({
      turnId: 'tu-1',
      status: 'completed',
      text: 'PING',
      error: null,
      tokenUsage: { total: breakdown, last: breakdown },
    })
  })

  it('refuses a turn/completed that names no finished Turn, rather than guessing one', async () => {
    const { turn, proc } = await started()
    notify(proc, 'turn/completed', {
      threadId: 'th-1',
      turn: { id: 'tu-1', status: 'inProgress', items: [] },
    })

    await expect(turn).rejects.toThrow('turn/completed carried no finished Turn')
  })

  it('refuses a usage reading it cannot read, once the Turn is over', async () => {
    const { server, turn, proc } = await started()
    notify(proc, 'thread/tokenUsage/updated', {
      threadId: 'th-1',
      turnId: 'tu-1',
      tokenUsage: { total: { totalTokens: 1 }, last: { totalTokens: 1 } },
    })
    // The server's Turn is still running, so roma's must be too.
    await expect(server.runTurn({ threadId: 'th-1', text: 'again' })).rejects.toThrow(
      'a Turn is already running',
    )
    notify(proc, 'turn/completed', {
      threadId: 'th-1',
      turn: { id: 'tu-1', status: 'completed', items: [], error: null },
    })

    await expect(turn).rejects.toThrow('thread/tokenUsage/updated carried no usage')
  })

  it('reports a failed Turn in the server’s own words', async () => {
    const { turn, proc } = await started()
    notify(proc, 'turn/completed', {
      threadId: 'th-1',
      turn: { id: 'tu-1', status: 'failed', items: [], error: { message: 'usage limit reached' } },
    })

    await expect(turn).resolves.toMatchObject({ status: 'failed', error: 'usage limit reached' })
  })

  it('declines a request from the server rather than leaving it waiting', async () => {
    const { proc } = await started()
    proc.emitStdout(
      `${JSON.stringify({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} })}\n`,
    )

    expect(proc.sent.at(-1)).toEqual({
      id: 'srv-1',
      error: {
        code: -32601,
        message: 'roma does not answer item/commandExecution/requestApproval from this harness',
      },
    })
  })

  it('fails, quoting stderr, when the process dies mid-Turn', async () => {
    const { turn, proc } = await started()
    proc.emitStderr('ERROR: 401 Unauthorized\n')
    proc.emitExit({ code: 1, signal: null })

    await expect(turn).rejects.toBeInstanceOf(CodexAppServerLost)
    await expect(turn).rejects.toThrow(/exited \(code 1.*\n.*401 Unauthorized/s)
  })
})

describe('stdout that is not the protocol', () => {
  it('keeps it in stderr, where a failure is explained from', async () => {
    const { server, proc } = harness()
    proc().emitStdout('panic: something\n')
    proc().emitStdout('[1,2]\n')
    proc().emitStdout(`${JSON.stringify({ id: null, error: { code: -32700 } })}\n`)

    expect(server.stderr).toEqual([
      '<not JSON on stdout> panic: something',
      '<unroutable on stdout> [1,2]',
      '<unroutable on stdout> {"id":null,"error":{"code":-32700}}',
    ])
  })
})

describe('a process that is gone', () => {
  it('fails a request still waiting for its reply', async () => {
    const { server, proc } = harness()
    const initialized = server.initialize('0.9.0')
    await flush()
    proc().emitExit({ code: null, signal: 'SIGKILL' })

    await expect(initialized).rejects.toThrow('codex app-server exited (code null, signal SIGKILL)')
  })

  it('refuses further requests instead of writing to it', async () => {
    const { server, proc } = harness()
    proc().emitExit({ code: 0, signal: null })

    await expect(server.initialize('0.9.0')).rejects.toBeInstanceOf(CodexAppServerLost)
    expect(proc().written).toEqual([])
  })
})

describe('closing', () => {
  it('closes stdin and waits for the exit', async () => {
    const { server, proc } = harness()
    const closed = server.close()
    expect(proc().stdinClosed).toBe(true)
    proc().emitExit({ code: 0, signal: null })
    await closed
    expect(proc().signals).toEqual([])
  })

  it('kills a process that outstays its grace', async () => {
    vi.useFakeTimers()
    try {
      const { server, proc } = harness()
      const closed = server.close(5_000)
      vi.advanceTimersByTime(4_999)
      expect(proc().signals).toEqual([])
      vi.advanceTimersByTime(1)
      expect(proc().signals).toEqual(['SIGKILL'])
      proc().emitExit({ code: null, signal: 'SIGKILL' })
      await closed
    } finally {
      vi.useRealTimers()
    }
  })
})
