import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession } from './claude-session.js'
import { MENU } from './model-menu.js'
import { readSystemInit, type SystemInit } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

// SEAM 2 — a real `claude -p`. Slow, and it spends Shared Window quota.
// Excluded from `npm test` by living in its own config; run it with
// `npm run test:seam2`.
//
// This is the one thing the Model Menu's design could not read for itself.
// ADR-0014 was written entirely off `grep` against the pinned build's minified
// bundle: the alias table, the two `/model` descriptors, the argument hint and
// the `[1m]` variants were all *read*, and nothing there is a behavioural
// measurement. What this does is spawn the pinned build once per Menu entry and
// ask it what it resolved to — the same `system/init.model` the Startup
// Self-Check asserts on, parsed by the same reader.
//
// If the live build disagrees with the bundle about what a Menu entry resolves
// to, the Menu is what changes. It offers what roma is willing to put the shared
// window behind, and an entry that does not resolve is an entry that will present
// as a process refusing to start on somebody's next message.

/**
 * The message each probe sends.
 *
 * The Startup Self-Check's own, and for its reason: `system/init` arrives once
 * there is a Turn to begin, so a probe that spawned and read the stream would
 * wait forever rather than measure anything.
 */
const PROBE = 'Reply with OK and nothing else. Do not use any tools.'

/** What one spawn on one model reported about itself. */
async function initOn(model: string): Promise<SystemInit> {
  const sessionId = randomUUID()
  const { configDir, cwd } = liveSessionDirs(`menu-${model}`)
  const credential = sharedWindowCredential()
  const session = new ClaudeSession({
    sessionId,
    cwd,
    env: buildEnv({ credential, configDir, inherit: process.env }),
    model,
  })

  const reported: { init: SystemInit | null } = { init: null }
  session.on('event', (event) => {
    const seen = readSystemInit(event)
    if (seen !== null && reported.init === null) reported.init = seen
  })

  try {
    session.start()
    await session.send(PROBE)
  } finally {
    await session.terminateOrKill()
  }

  const { init } = reported
  if (init === null) throw new Error(`no system/init arrived for --model ${model}`)
  return init
}

describe('every model on the Menu, against the pinned build', () => {
  // One spawn per Menu entry and no more, because each is a real Turn on the
  // window everybody shares.
  //
  // Spawned on the **alias** rather than on the id, and that is the choice worth
  // explaining. The alias table is the half that was read rather than measured —
  // `{opus:"claude-opus-5", sonnet:"claude-sonnet-5", haiku:"claude-haiku-4-5"}`,
  // out of a minified bundle — and the id is the half roma passes to `--model`.
  // Asking the build to resolve the alias and demanding the id back measures both
  // at once: the reading was right, and the string roma sends is what this build
  // calls that model. Spawning on the id would assert that `--model X` reports X,
  // which is nearly a tautology and leaves the reading unmeasured.
  it.each(Object.entries(MENU))('resolves %s to the id the Menu names', async (name, model) => {
    const init = await initOn(name)

    expect(init.model).toBe(model)
    // Recorded rather than asserted: everything here is version-specific, so the
    // day this starts failing the first question is what changed underneath it.
    console.log(
      `seam 2: /model ${name} resolved to ${String(init.model)} ` +
        `on Claude Code ${String(init.claudeCodeVersion)}`,
    )
  })
})

/**
 * Which of Claude Code's two `/model` descriptors is live.
 *
 * The one thing ADR-0014 could not settle statically. The pinned bundle declares
 * both `{type:"local", name:"model", supportsNonInteractive:!0,
 * argumentHint:"<model>"}` and a second `{type:"local-jsx", name:"model", …}`,
 * and which one wins depends on a predicate that cannot be read.
 *
 * Nothing roma does depends on the answer — `/model` is roma's own Command and is
 * never relayed, which is the decision this measurement exists to inform rather
 * than to justify. It is recorded because the alternative to knowing is guessing
 * the day somebody proposes relaying it after all.
 */
describe('what Claude Code does with a /model of its own', () => {
  it('answers a relayed /model, one way or the other', async () => {
    const sessionId = randomUUID()
    const { configDir, cwd } = liveSessionDirs('relayed-model')
    const credential = sharedWindowCredential()
    const session = new ClaudeSession({
      sessionId,
      cwd,
      env: buildEnv({ credential, configDir, inherit: process.env }),
    })

    try {
      session.start()
      const bare = await session.send('/model')
      const argued = await session.send('/model opus')

      // Recorded, not asserted. What a picker does in `-p` and what a
      // non-interactive `/model <name>` answers are both facts about one build,
      // and pinning either as an expectation here would fail on a release for
      // reasons that say nothing about roma.
      console.log(
        `seam 2: relayed "/model" answered ${JSON.stringify(bare.text)} ` +
          `(turns=${String(bare.turns)}, cost=${String(bare.costUsd)}); ` +
          `"/model opus" answered ${JSON.stringify(argued.text)} ` +
          `(turns=${String(argued.turns)}, cost=${String(argued.costUsd)})`,
      )

      // The one thing worth failing on: both completed, so what is above is a
      // measurement rather than a timeout.
      expect(typeof bare.text).toBe('string')
      expect(typeof argued.text).toBe('string')
    } finally {
      await session.terminateOrKill()
    }
  })
})
