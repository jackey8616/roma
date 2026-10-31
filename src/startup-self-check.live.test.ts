import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess } from './claude-process.js'
import { ClaudeSession } from './claude-session.js'
import { startupSelfCheck, StartupSelfCheckFailed } from './startup-self-check.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

const BOGUS_KEY = 'sk-ant-not-a-real-key-seam2'

describe('the startup self-check against a real claude -p', () => {
  it('passes under the Shared Window token, on the pinned model', async () => {
    const { configDir, cwd } = liveSessionDirs('self-check-pass')
    const credential = sharedWindowCredential()

    const report = await startupSelfCheck({
      credential,
      env: buildEnv({ credential, configDir, inherit: process.env }),
      cwd,
    })

    expect(report.apiKeySource).toBe('none')
    expect(report.model).toBe('claude-sonnet-5')
    expect(report.costUsd).toBeGreaterThan(0)
    console.log(
      `seam 2 ran against Claude Code ${String(report.claudeCodeVersion)} — ` +
        `self-check took ${report.durationMs}ms and cost $${report.costUsd}`,
    )
  })

  it('refuses a stray API key at system/init, long before the retries', async () => {
    const { configDir, cwd } = liveSessionDirs('self-check-stray-key')
    const startedAt = Date.now()

    const refused = await startupSelfCheck({
      credential: sharedWindowCredential(),
      env: buildEnv({
        credential: { kind: 'overflow', apiKey: BOGUS_KEY },
        configDir,
        inherit: process.env,
      }),
      cwd,
    }).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(StartupSelfCheckFailed)
    expect((refused as StartupSelfCheckFailed).failures[0]).toMatchObject({
      condition: 'credential',
    })
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  })
})

describe('system/init', () => {
  it('does not arrive until something is sent', async () => {
    const { configDir, cwd } = liveSessionDirs('init-needs-a-message')
    const credential = sharedWindowCredential()
    const session = new ClaudeSession({
      sessionId: randomUUID(),
      cwd,
      env: buildEnv({ credential, configDir, inherit: process.env }),
      spawn: spawnClaudeProcess,
    })

    const inits: unknown[] = []
    session.on('event', (event) => {
      if (event.type === 'system' && event['subtype'] === 'init') inits.push(event)
    })
    session.start()
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await session.terminate()

    expect(inits).toEqual([])
  })
})
