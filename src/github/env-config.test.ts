import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { readMinterEnv, realGhPath } from './env-config.js'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function keyFileHolding(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-key-'))
  dirs.push(dir)
  const path = join(dir, 'app.pem')
  writeFileSync(path, contents)
  return path
}

describe('reading the GitHub App out of the environment', () => {
  it('reads the id and the key off disk', () => {
    const keyFile = keyFileHolding('-----BEGIN PRIVATE KEY-----\nnot really\n')

    expect(
      readMinterEnv({ ROMA_GITHUB_APP_ID: '12345', ROMA_GITHUB_PRIVATE_KEY_FILE: keyFile }),
    ).toEqual({
      appId: '12345',
      privateKey: '-----BEGIN PRIVATE KEY-----\nnot really\n',
    })
  })

  it('refuses when either half is missing, naming both at once', () => {
    try {
      readMinterEnv({})
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as ConfigurationMissing).problems).toEqual([
        'ROMA_GITHUB_APP_ID is not set.',
        'ROMA_GITHUB_PRIVATE_KEY_FILE is not set.',
      ])
    }
  })

  it('refuses a key file it cannot read, and says why', () => {
    expect(() =>
      readMinterEnv({
        ROMA_GITHUB_APP_ID: '12345',
        ROMA_GITHUB_PRIVATE_KEY_FILE: '/nowhere/app.pem',
      }),
    ).toThrow(/ROMA_GITHUB_PRIVATE_KEY_FILE.*could not read/s)
  })

  it('refuses a key file that is empty', () => {
    expect(() =>
      readMinterEnv({
        ROMA_GITHUB_APP_ID: '12345',
        ROMA_GITHUB_PRIVATE_KEY_FILE: keyFileHolding('   \n'),
      }),
    ).toThrow(/empty/)
  })
})

describe('where the real gh is', () => {
  it('defaults to the path the image puts it at', () => {
    expect(realGhPath({})).toBe('/usr/local/lib/roma/gh')
  })

  it('is overridable, for a checkout and for a test', () => {
    expect(realGhPath({ ROMA_GH_BIN: '/opt/homebrew/bin/gh' })).toBe('/opt/homebrew/bin/gh')
  })
})
