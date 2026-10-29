import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const HOOK = `${root}.claude/hooks/block-no-verify.mjs`

const WHY =
  'A git command that skips the hooks must be refused (ADR-0031): the pre-commit hook runs ' +
  'the checks that hold roma’s guardrails, and a commit that skipped it is one they never saw.'

/** What the hook does with one Bash command: 2 refuses it, 0 lets it run. */
function verdict(command: string): number | null {
  const run = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  })
  return run.status
}

describe('a command that skips the git hooks [fence:no-verify-is-refused]', () => {
  it.each([
    'git commit --no-verify -m "wip"',
    'git commit -n -m wip',
    'git commit -anm wip',
    'git push --no-verify origin feat/x',
    'npm test && git commit --no-verify -m x',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -C /repo commit --no-verify',
  ])('refuses %s', (command) => {
    expect(verdict(command), WHY).toBe(2)
  })

  it.each([
    'git commit -m "explain no verify in the docs"',
    'git commit -m wip',
    'git push -n origin main',
    'git log --oneline',
    'echo nothing to do with git',
    'git commit -m -n',
  ])('lets %s run', (command) => {
    expect(verdict(command), WHY).toBe(0)
  })

  it('is what Claude Code runs before every Bash command', () => {
    const settings = JSON.parse(readFileSync(`${root}.claude/settings.json`, 'utf8'))
    const bash = settings.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash')

    expect(bash.hooks[0].command, WHY).toContain('.claude/hooks/block-no-verify.mjs')
  })

  it('has a pre-commit hook to protect, and npm installs it', () => {
    const hook = `${root}.githooks/pre-commit`
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

    expect(statSync(hook).mode & 0o111, WHY).not.toBe(0)
    expect(readFileSync(hook, 'utf8'), WHY).toContain('npm run --silent lint')
    expect(pkg.scripts.prepare, WHY).toContain('core.hooksPath .githooks')
  })
})
