import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { liveSessionDirs, liveWorkRoot } from './live-claude.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Every directory Claude Code would walk on its way up from `start`, `start`
 * included.
 *
 * Project memory and project skills are found by walking the working directory's
 * ancestors, so "is this directory isolated" is a question about the whole chain
 * rather than about the leaf.
 */
function selfAndAncestors(start: string): string[] {
  const chain: string[] = []
  let dir = start
  for (; !chain.includes(dir); dir = dirname(dir)) chain.push(dir)
  return chain
}

/**
 * What a Session spawned in `cwd` would inherit from the filesystem above it.
 *
 * Named for the failure rather than the mechanism: a hit here is roma's own
 * `CLAUDE.md` or `.claude/skills/` in front of an agent under test.
 */
function projectContextAbove(cwd: string): string[] {
  return selfAndAncestors(cwd).flatMap((dir) =>
    [join(dir, 'CLAUDE.md'), join(dir, '.claude')].filter((path) => existsSync(path)),
  )
}

// The seam 2 helpers are the only test support with a claim in them that can be
// wrong quietly. `configDir` exists so a spawned process cannot resolve
// credentials against the developer's machine; the working directory is supposed
// to do the same for the developer's project instructions, and for a while it did
// not — the directories lived at `.tmp/seam2/`, inside the repository, so every
// live Session read roma's own `CLAUDE.md` and project skills (#101). Nothing at
// seam 2 could catch that: those tests spend real money and the contamination
// made them pass. This one is free and it fails.
describe('seam 2 working directories', () => {
  const probe = 'isolation-probe'

  afterAll(() => {
    // The config dir is left alone on purpose — it survives between runs, and
    // that is the point of it. Only what this file asked to be created goes.
    rmSync(liveSessionDirs(probe).cwd, { recursive: true, force: true })
    rmSync(liveWorkRoot(probe).workRoot, { recursive: true, force: true })
  })

  it('gives a Session no project memory or skills anywhere above it', () => {
    const { cwd } = liveSessionDirs(probe)

    expect(projectContextAbove(cwd)).toEqual([])
    expect(cwd.startsWith(REPO_ROOT)).toBe(false)
  })

  it('gives a pool no project memory or skills anywhere above its work root', () => {
    const { workRoot } = liveWorkRoot(probe)

    // The pool creates the per-Session directory itself, so the root's chain is
    // the whole of what a Session under it can see.
    expect(projectContextAbove(workRoot)).toEqual([])
    expect(workRoot.startsWith(REPO_ROOT)).toBe(false)
  })

  it('keeps the config dir outside the checkout too', () => {
    const { configDir } = liveSessionDirs(probe)

    // `~/.claude/CLAUDE.md` is user memory, read from the config dir rather than
    // from the working directory. It is already a throwaway; this pins that it is
    // a throwaway outside the checkout, so no file the repo tracks can become one.
    expect(configDir.startsWith(REPO_ROOT)).toBe(false)
  })
})
