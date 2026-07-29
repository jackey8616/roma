import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { spawnClaudeProcess } from './claude-process.js'
import { ClaudeSession } from './claude-session.js'
import { startupSelfCheck, StartupSelfCheckFailed } from './startup-self-check.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and the passing case spends Shared Window
// quota. Excluded from `npm test` by living in its own config; run it with
// `npm run test:seam2`.
//
// This is where the startup self-check is worth anything at all. Everything it
// asserts is a fact about a real CLI resolving a real credential, and a check
// verified only against recordings would be a check that agrees with a fixture.

/** A key shaped like one and belonging to nobody. It never gets as far as being used. */
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
    // What a boot pays to know this. Small, and spent every time roma starts.
    expect(report.costUsd).toBeGreaterThan(0)
    // Recorded rather than asserted: behaviour is version-specific, so a future
    // failure needs to know which build produced this baseline.
    console.log(
      `seam 2 ran against Claude Code ${String(report.claudeCodeVersion)} — ` +
        `self-check took ${report.durationMs}ms and cost $${report.costUsd}`,
    )
  })

  // The failure ADR-0002 is about, staged the way it actually happens: roma
  // intends the Shared Window, and the environment resolves an API key anyway.
  //
  // The timing is half the assertion. A bad credential does not fail fast — the
  // prototype measured ten `api_retry` events across 182 seconds before the 401
  // surfaced — so a check that waited for the Turn to fail would take three
  // minutes to say so. `system/init` carries the answer before the first API
  // call, and this is what pins that.
  it('refuses a stray API key at system/init, long before the retries', async () => {
    const { configDir, cwd } = liveSessionDirs('self-check-stray-key')
    const startedAt = Date.now()

    const refused = await startupSelfCheck({
      credential: sharedWindowCredential(),
      // Built from the wrong credential on purpose: this is what a deployment
      // with a leftover key in its environment hands the process.
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
    // Nowhere near the 182 seconds a bad credential spends retrying.
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  })
})

/**
 * The measurement the check's shape rests on.
 *
 * `system/init` does not arrive on spawn. It arrives once there is a Turn to
 * begin, so a self-check that spawned a process and read the stream — cheaper,
 * and the obvious design — would wait forever rather than assert anything. The
 * probe Turn is not an extravagance; it is the only way to get the event.
 *
 * Free: nothing is ever sent, so no Turn begins and no tokens are spent.
 */
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
    // Ten times the ~500ms an init takes once a message has been sent.
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    await session.terminate()

    expect(inits).toEqual([])
  })
})
