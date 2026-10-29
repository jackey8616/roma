import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexHomeProblems, readCodexHome } from './codex-home.js'

describe('reading ROMA_CODEX_HOME', () => {
  it('is null, with nothing to say, where the deployment configured no Codex', () => {
    const problems: string[] = []
    expect(readCodexHome({}, problems)).toBeNull()
    expect(readCodexHome({ ROMA_CODEX_HOME: '' }, problems)).toBeNull()
    expect(problems).toEqual([])
  })

  it('takes an absolute path', () => {
    const problems: string[] = []
    expect(readCodexHome({ ROMA_CODEX_HOME: '/var/lib/roma/codex' }, problems)).toBe(
      '/var/lib/roma/codex',
    )
    expect(problems).toEqual([])
  })

  it('refuses a relative one', () => {
    const problems: string[] = []
    expect(readCodexHome({ ROMA_CODEX_HOME: 'codex' }, problems)).toBeNull()
    expect(problems).toEqual(['ROMA_CODEX_HOME is "codex", which is not an absolute path.'])
  })
})

describe('what is wrong with a CODEX_HOME', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roma-codex-home-'))
  })

  afterEach(() => {
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  })

  it('is nothing, for a writable directory with a seeded auth.json', () => {
    writeFileSync(join(root, 'auth.json'), '{}')
    expect(codexHomeProblems(root)).toEqual([])
  })

  it('names a directory that does not exist', () => {
    const missing = join(root, 'missing')
    expect(codexHomeProblems(missing)).toEqual([
      `ROMA_CODEX_HOME is ${missing}, which does not exist.`,
    ])
  })

  it('names a path that is a file', () => {
    const file = join(root, 'file')
    writeFileSync(file, '')
    expect(codexHomeProblems(file)).toEqual([
      `ROMA_CODEX_HOME is ${file}, which is not a directory.`,
    ])
  })

  it('names an auth.json nobody seeded, and says how to seed it without a copy', () => {
    const [problem, ...rest] = codexHomeProblems(root)
    expect(rest).toEqual([])
    expect(problem).toContain('auth.json does not exist.')
    expect(problem).toContain(`CODEX_HOME=${root} codex login`)
    expect(problem).toContain('never by copying')
  })

  it('names an auth.json that is a directory as unseeded', () => {
    mkdirSync(join(root, 'auth.json'))
    expect(codexHomeProblems(root)).toHaveLength(1)
  })

  it.skipIf(process.getuid?.() === 0)('names a directory roma cannot write to', () => {
    writeFileSync(join(root, 'auth.json'), '{}')
    chmodSync(root, 0o500)
    expect(codexHomeProblems(root)).toEqual([expect.stringMatching(/cannot write to/)])
  })
})
