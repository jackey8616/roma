import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { liveCodexCwd } from './live-codex.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// The Codex live test's claim that can be wrong quietly, asserted for free: the
// same isolation `live-claude.test.ts` holds seam 2 to (#101), for the file Codex
// walks up looking for.
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
