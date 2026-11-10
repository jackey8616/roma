import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { liveCodexCwd, pinnedCodexVersion, unpinnedCodex } from './live-codex.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

describe('Codex live working directories', () => {
  const probe = 'isolation-probe'

  afterAll(() => {
    rmSync(liveCodexCwd(probe), { recursive: true, force: true })
  })

  it('gives a thread no AGENTS.md anywhere above it, and sits outside the checkout', () => {
    const cwd = liveCodexCwd(probe)
    const above: string[] = []
    for (let dir = cwd; !above.includes(dir); dir = dirname(dir)) above.push(dir)

    expect(above.map((dir) => join(dir, 'AGENTS.md')).filter((path) => existsSync(path))).toEqual(
      [],
    )
    expect(cwd.startsWith(REPO_ROOT)).toBe(false)
  })
})

describe('the build a Codex live run spends on [fence:codex-live-runs-only-the-pin]', () => {
  it('reads the pin the image carries', () => {
    expect(pinnedCodexVersion('FROM node\nARG CODEX_VERSION=9.8.7\n')).toBe('9.8.7')
    expect(() => pinnedCodexVersion('FROM node\n')).toThrow('assigns no ARG CODEX_VERSION')
  })

  it('accepts the pinned build', () => {
    expect(unpinnedCodex(`codex-cli ${pinnedCodexVersion()}`, pinnedCodexVersion())).toBeNull()
  })

  it('refuses any other build, naming both', () => {
    expect(unpinnedCodex('codex-cli 0.166.0', '0.167.0')).toBe(
      'the Codex live tests measure the pinned build, Codex 0.167.0, and the codex on PATH ' +
        'reports "codex-cli 0.166.0". Put Codex 0.167.0 first on PATH before spending a Turn.',
    )
    expect(unpinnedCodex('codex-cli 0.167.0-alpha.1', '0.167.0')).not.toBeNull()
  })
})
