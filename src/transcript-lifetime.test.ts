import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sources } from '../test/support/sources.js'

describe('the Transcript is not roma’s to delete', () => {
  it('lets only the files that build a process environment name a config directory', () => {
    const offenders = sources()
      .filter(({ file }) => !ENVIRONMENT_BUILDERS.includes(file) && file !== THE_ONE_MOVE)
      .filter(({ source }) => NAMES_A_CONFIG_DIR.test(codeOnly(source)))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('never joins, reads or deletes anything under one', () => {
    const offenders = sources()
      .filter(({ file }) => file !== THE_ONE_MOVE)
      .filter(({ source }) => reachesInside(source))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('lets the one move into per-Session directories rename and nothing else [fence:transcripts-are-moved-never-copied-or-deleted]', () => {
    const why =
      'ADR-0036 moves each Transcript from the shared config directory into its own ' +
      'Session’s, once, and amends ADR-0006 for that move alone. A copy is a second copy of ' +
      'a conversation; a delete or a read is roma doing to a Transcript what ADR-0006 says ' +
      'it never does.'
    const move = sources().find(({ file }) => file === THE_ONE_MOVE)

    expect(move, why).toBeDefined()
    expect(codeOnly(move?.source ?? ''), why).not.toMatch(TOUCHES_CONTENT)
  })
})

const THE_ONE_MOVE = 'transcript-move.ts'

const TOUCHES_CONTENT =
  /\b(rmSync|rm|rmdirSync|unlinkSync|unlink|readFileSync|createReadStream|writeFileSync|copyFileSync|cpSync|copyFile|cp|open|openSync)\b/

const ENVIRONMENT_BUILDERS = ['env-config.ts', 'build-env.ts', 'startup.ts']

const NAMES_A_CONFIG_DIR = /\b(configDir|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE_CONFIG_DIR)\b/

const ENTERS =
  /\b(join|resolve|relative|basename|dirname|rmSync|rm|rmdirSync|unlinkSync|unlink|readdirSync|readFileSync|createReadStream|existsSync|statSync|globSync)\b/

function reachesInside(source: string): boolean {
  const lines = codeOnly(source).split('\n')
  return lines.some((line, index) => {
    if (!NAMES_A_CONFIG_DIR.test(line)) return false
    const window = lines.slice(Math.max(0, index - 1), index + 2).join('\n')
    return ENTERS.test(window) || CONCATENATES.test(window)
  })
}

const CONCATENATES = /\bconfigDir\b\s*\+|\$\{\s*configDir\s*\}\s*[/\\]/

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => (/ /.test(literal) ? '' : literal))
}
