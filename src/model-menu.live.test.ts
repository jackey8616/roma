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

/**
 * Two spawns per Menu entry, because there are two facts here and no single
 * spawn holds both.
 *
 * The first version of this file tried. It spawned on the **alias** and demanded
 * the **id** back, reasoning that asking the build to resolve `haiku` and being
 * handed `claude-haiku-4-5` would measure the bundle reading and the string roma
 * sends at once — and that spawning on the id would assert that `--model X`
 * reports X, which is nearly a tautology.
 *
 * Run, it went red on `haiku` and the Menu was not wrong. This build expands
 * `haiku` to `claude-haiku-4-5-20251001` and `opus` to `claude-opus-5`: its alias
 * table is not uniform about dated snapshots, and roma never sends an alias
 * anyway. One spawn conflated an assertion about roma's own invariant with a
 * recording of a table roma does not control, and what it bought for the saved
 * Turn was a failure that named neither.
 *
 * So: one spawn for what roma rests on, one for what roma read. Still minimal
 * Turns, and each is a real one on the window everybody shares.
 */
describe('every model on the Menu, against the pinned build', () => {
  // What roma rests on. `--model` receives the **id**, `system/init.model` is
  // where the Startup Self-Check reads the model back, and the Audit Record and
  // the Operator Log both file the string roma sent — so an id this build did
  // not accept is a process that refuses to start on somebody's next message,
  // and an id it accepted and renamed is a ledger with two names for one model.
  //
  // Not a tautology, whatever it looks like: `--model` is where a name this
  // build has never heard of would be refused, and the echo is the only evidence
  // that what roma files is what ran.
  it.each(Object.entries(MENU))('runs on the id the Menu holds for %s', async (name, model) => {
    const init = await initOn(model)

    expect(init.model).toBe(model)
    console.log(
      `seam 2: --model ${model} (${name}) reported ${String(init.model)} ` +
        `on Claude Code ${String(init.claudeCodeVersion)}`,
    )
  })

  // What roma read rather than measured: that the name a Caller types and the id
  // roma sends are the same model. ADR-0014 took this from a minified object
  // literal, which is a reading of a build and not a fact about one.
  //
  // The id, or a dated snapshot of it — asserted that way rather than as equality
  // because the two are not one string here and the difference is not drift. What
  // this still refuses is the thing worth knowing: an alias re-pointed at another
  // model, which is the day the Menu — one person's judgement about one build —
  // starts handing people a model they did not ask for while roma reports the one
  // they did.
  it.each(Object.entries(MENU))('means by %s the model the Menu names', async (name, model) => {
    const init = await initOn(name)

    expect(String(init.model)).toMatch(new RegExp(`^${model}(-\\d{8})?$`))
    // Recorded as well as asserted: everything here is version-specific, so the
    // day this starts failing the first question is what moved underneath it.
    console.log(
      `seam 2: --model ${name} expanded to ${String(init.model)} ` +
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
 *
 * What one run found is in `docs/model-menu-verification.md`, where a measurement
 * of a specific build belongs. It is not repeated here: this file's job is to
 * produce the reading, and prose that restates a result goes stale the first time
 * somebody runs it against a newer pin without touching the comment.
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
