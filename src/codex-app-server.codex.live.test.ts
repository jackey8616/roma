import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CodexAppServer,
  type CodexInitialized,
  type CodexThread,
  type CodexTurn,
} from './codex-app-server.js'
import {
  codexVersion,
  liveCodexCwd,
  PINNED_CODEX_MODEL,
  seededCodexHome,
} from '../test/support/live-codex.js'

// A real `codex app-server`. Slow, and it spends Codex's Shared Window, not
// Claude Code's. Excluded from `npm test` and from seam 2 alike; run it with
// `npm run test:codex-live`.
//
// #149's floor: a handshake, a thread on the pinned model, and one completed
// Turn against the operator-seeded credential. What this prints is what
// `docs/codex-app-server-verification.md` records.

const PING = 'Reply with exactly the word PING and nothing else. Do not run any commands.'

describe('a real codex app-server', () => {
  const codexHome = seededCodexHome()
  const model = PINNED_CODEX_MODEL
  const cwd = liveCodexCwd('harness')
  let server: CodexAppServer
  let initialized: CodexInitialized
  let thread: CodexThread
  let turn: CodexTurn

  beforeAll(async () => {
    // Only what the process needs to find itself and its binary: the developer's
    // own environment is not the container's.
    const inherit: Record<string, string> = {}
    for (const name of ['PATH', 'HOME', 'TMPDIR']) {
      const value = process.env[name]
      if (value !== undefined) inherit[name] = value
    }

    server = new CodexAppServer({ codexHome, cwd, inherit })
    initialized = await server.initialize('0.0.0-live')
    thread = await server.startThread({ model, cwd })
    turn = await server.runTurn({ threadId: thread.threadId, text: PING })

    console.log(JSON.stringify({ build: codexVersion(), initialized, thread, turn }, null, 2))
  })

  afterAll(async () => {
    await server?.close()
  })

  it('resolves the CODEX_HOME it was handed, and no other', () => {
    expect(initialized.codexHome).toBe(codexHome)
  })

  it('starts the thread on the pinned model', () => {
    expect(thread.model).toBe(model)
  })

  it('completes one Turn and answers it', () => {
    expect(turn.status).toBe('completed')
    expect(turn.error).toBeNull()
    expect(turn.text).toContain('PING')
  })

  it('reports token usage for the Turn', () => {
    expect(turn.tokenUsage?.last.totalTokens).toBeGreaterThan(0)
  })
})
