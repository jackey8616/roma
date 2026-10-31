#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const file = String(input?.tool_input?.file_path ?? '')

if (!/\.[mc]?[jt]s$/.test(file) || !existsSync(file)) process.exit(0)

const want = readFileSync(`${root}.nvmrc`, 'utf8').trim()
const have = process.versions.node.split('.')[0]
if (have !== want) {
  process.stderr.write(
    `The comment check did not run on ${file}: it needs Node ${want} (.nvmrc) and this hook ` +
      `ran under Node ${have}. Do not write comments there anyway (ADR-0032), and tell the ` +
      'user to start Claude Code under `nvm use` so the check can run.\n',
  )
  process.exit(2)
}

const { ESLint } = await import('eslint')
const eslint = new ESLint({ cwd: root, warnIgnored: false })
if (await eslint.isPathIgnored(file)) process.exit(0)

const results = await eslint.lintFiles([file])
if (results.every((result) => result.messages.length === 0)) process.exit(0)

const formatter = await eslint.loadFormatter('stylish')
process.stderr.write(
  (await formatter.format(results)) +
    '\nroma has no comments, only tool directives (ADR-0032). Remove the comments above ' +
    'now, before anything else; do not move their text into a SAFETY: line, a directive ' +
    'reason or a string. If one was guarding against a change, write that as a test.\n',
)
process.exit(2)
