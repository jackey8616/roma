import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { liveSessionDirs, liveWorkRoot } from './live-claude.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function selfAndAncestors(start: string): string[] {
  const chain: string[] = []
  let dir = start
  for (; !chain.includes(dir); dir = dirname(dir)) chain.push(dir)
  return chain
}

function projectContextAbove(cwd: string): string[] {
  return selfAndAncestors(cwd).flatMap((dir) =>
    [join(dir, 'CLAUDE.md'), join(dir, '.claude')].filter((path) => existsSync(path)),
  )
}

describe('seam 2 working directories', () => {
  const probe = 'isolation-probe'

  afterAll(() => {
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

    expect(projectContextAbove(workRoot)).toEqual([])
    expect(workRoot.startsWith(REPO_ROOT)).toBe(false)
  })

  it('keeps the config dir outside the checkout too', () => {
    const { configDir } = liveSessionDirs(probe)

    expect(configDir.startsWith(REPO_ROOT)).toBe(false)
  })
})
