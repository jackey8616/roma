import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEnv } from './build-env.js'
import { ClaudeSession } from './claude-session.js'
import { MENU } from './model-menu.js'
import { readSystemInit, type SystemInit } from './stream-events.js'
import { liveSessionDirs, sharedWindowCredential } from '../test/support/live-claude.js'

const PROBE = 'Reply with OK and nothing else. Do not use any tools.'

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
  it.each(Object.entries(MENU))('runs on the id the Menu holds for %s', async (name, model) => {
    const init = await initOn(model)

    expect(init.model).toBe(model)
    console.log(
      `seam 2: --model ${model} (${name}) reported ${String(init.model)} ` +
        `on Claude Code ${String(init.claudeCodeVersion)}`,
    )
  })

  it.each(Object.entries(MENU))('means by %s the model the Menu names', async (name, model) => {
    const init = await initOn(name)

    expect(String(init.model)).toMatch(new RegExp(`^${model}(-\\d{8})?$`))
    console.log(
      `seam 2: --model ${name} expanded to ${String(init.model)} ` +
        `on Claude Code ${String(init.claudeCodeVersion)}`,
    )
  })
})

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

      console.log(
        `seam 2: relayed "/model" answered ${JSON.stringify(bare.text)} ` +
          `(turns=${String(bare.turns)}, cost=${String(bare.costUsd)}); ` +
          `"/model opus" answered ${JSON.stringify(argued.text)} ` +
          `(turns=${String(argued.turns)}, cost=${String(argued.costUsd)})`,
      )

      expect(typeof bare.text).toBe('string')
      expect(typeof argued.text).toBe('string')
    } finally {
      await session.terminateOrKill()
    }
  })
})
