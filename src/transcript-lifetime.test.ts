import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sources } from '../test/support/sources.js'

describe('the Transcript is not roma’s to delete', () => {
  it('lets only the files that build a process environment name a config directory', () => {
    const offenders = sources()
      .filter(({ file }) => !ENVIRONMENT_BUILDERS.includes(file))
      .filter(({ source }) => NAMES_A_CONFIG_DIR.test(codeOnly(source)))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })

  it('never joins, reads or deletes anything under one', () => {
    const offenders = sources().filter(({ source }) => reachesInside(source))

    expect(offenders.map(({ file }) => file)).toEqual([])
  })
})

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
