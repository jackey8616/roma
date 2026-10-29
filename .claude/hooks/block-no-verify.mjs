#!/usr/bin/env node
// A Claude Code PreToolUse hook: refuse a git command that skips the hooks.
// Plain JavaScript because it runs under whatever `node` is on PATH.
// Enforced by `fence:no-verify-is-refused`.

import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const command = String(input?.tool_input?.command ?? '')
const reason = bypass(command)

if (reason !== null) {
  process.stderr.write(
    `Refused: ${reason}. The pre-commit hook runs the checks that hold roma's ` +
      'guardrails (ADR-0031), and skipping it lands a change those checks never ' +
      'saw; CI would refuse it anyway, later and more expensively. Fix what the ' +
      'hook reports, or ask the user to run the command themselves.\n',
  )
  process.exit(2)
}

/** Why `command` skips git's hooks, or null when it does not. */
function bypass(command) {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/)
    const git = words.indexOf('git')
    if (git === -1) continue
    const rest = words.slice(git + 1)
    if (rest.includes('--no-verify')) return '`--no-verify` skips the git hooks'
    if (
      rest.some(
        (w, i) =>
          /^core\.hooksPath=/i.test(w) && ['-c', '--config-env'].includes(rest[i - 1] ?? ''),
      )
    ) {
      return 'overriding core.hooksPath skips the git hooks'
    }
    const sub = rest.find((w) => !w.startsWith('-') && !/=/.test(w))
    if (sub === 'commit') {
      const flags = rest.slice(rest.indexOf('commit') + 1)
      const takesValue = new Set(['-m', '-F', '-C', '-c', '-t', '--author', '--date'])
      if (
        flags.some(
          (w, i) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w) && !takesValue.has(flags[i - 1] ?? ''),
        )
      ) {
        return '`git commit -n` is `--no-verify`'
      }
    }
  }
  return null
}
