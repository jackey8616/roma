import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const HOOK = `${root}.claude/hooks/no-comments.mjs`
const probes = mkdtempSync(join(root, 'scripts', '.hook-probe-'))

afterAll(() => rmSync(probes, { recursive: true, force: true }))

const WHY =
  'An agent copies the comments it reads, so roma keeps none (ADR-0032), and the agent must ' +
  'hear about a comment in the same turn it wrote one. A hook that lets one through leaves it ' +
  'for the next agent to copy; a hook that refuses a tool directive blocks work that is allowed.'

function verdict(name: string, text: string): { status: number | null; stderr: string } {
  const file = join(probes, name)
  writeFileSync(file, text)
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } }),
    encoding: 'utf8',
  })
  return { status: run.status, stderr: run.stderr }
}

describe('a comment written by an agent is reported at once [fence:no-comments-hook]', () => {
  it.each([
    ['a line comment', 'a.ts', '// explains\nexport const a = 1\n'],
    ['JSDoc on an export', 'b.ts', '/** Explains. */\nexport const b = 1\n'],
    ['a SAFETY: line', 'c.mjs', '// SAFETY: sized above\nexport const c = 1\n'],
    [
      'a directive with free text',
      'd.ts',
      '// @ts-expect-error -- wrong on purpose\nexport const d: number = "x"\n',
    ],
  ])('reports %s', (_, name, text) => {
    const { status, stderr } = verdict(name, text)

    expect(status, WHY).toBe(2)
    expect(stderr, WHY).toContain('ADR-0032')
  })

  it.each([
    ['code alone', 'e.ts', 'export const e = 1\n'],
    [
      'a directive citing a fence',
      'f.ts',
      '// @ts-expect-error -- fence:no-comments-hook\nexport const f: number = "x"\n',
    ],
    ['a #! line', 'g.mjs', '#!/usr/bin/env node\nexport const g = 1\n'],
    ['a file ESLint does not read', 'h.md', '<!-- prose is fine in Markdown -->\n'],
  ])('lets %s through', (_, name, text) => {
    expect(verdict(name, text).status, WHY).toBe(0)
  })

  it('is what Claude Code runs after every file it writes', () => {
    const settings = JSON.parse(readFileSync(`${root}.claude/settings.json`, 'utf8'))
    const after = settings.hooks.PostToolUse.find(
      (h: { matcher: string }) => h.matcher === 'Write|Edit|MultiEdit',
    )

    expect(after.hooks[0].command, WHY).toContain('.claude/hooks/no-comments.mjs')
  })
})
