import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigurationMissing } from '../env-config.js'
import { readEgressEnv } from './env-config.js'
import { readGatewayEnv } from './gateway.js'

const dir = mkdtempSync(join(tmpdir(), 'roma-egress-env-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = 'a'.repeat(64)
const tokenFile = join(dir, 'egress.token')
writeFileSync(tokenFile, `${TOKEN}\n`)
const shortFile = join(dir, 'short.token')
writeFileSync(shortFile, 'too-short')

const GATEWAY = { ROMA_EGRESS_GATEWAY: 'http://egress:3128', ROMA_EGRESS_TOKEN_FILE: tokenFile }

function problems(env: Record<string, string>): string {
  try {
    readEgressEnv(env)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationMissing)
    return (error as Error).message
  }
  throw new Error('read without a problem')
}

describe('readEgressEnv', () => {
  it('refuses a deployment that names no gateway at all, saying how to run without one [fence:egress-refuses-a-silent-open-network]', () => {
    const why =
      'GHSA-7hpq-f638-956r: the README docker run left the agent with the whole internet, and ' +
      'roma said so only as "gateway":null in a log. Running without the allowlist has to be ' +
      'a choice the operator writes down, not the default.'

    expect(problems({}), why).toMatch(/ROMA_EGRESS_GATEWAY is not set/)
    expect(problems({}), why).toMatch(/ROMA_EGRESS_GATEWAY=none/)
  })

  it('is absent when the operator writes down that there is no gateway', () => {
    expect(readEgressEnv({ ROMA_EGRESS_GATEWAY: 'none' })).toBeNull()
  })

  it('refuses "none" alongside a token or an allowlist, which nothing would enforce', () => {
    expect(problems({ ROMA_EGRESS_GATEWAY: 'none', ROMA_EGRESS_ALLOW: 'pypi.org' })).toMatch(
      /is "none", but ROMA_EGRESS_ALLOW is set/,
    )
    expect(problems({ ROMA_EGRESS_GATEWAY: 'none', ROMA_EGRESS_TOKEN_FILE: tokenFile })).toMatch(
      /is "none", but ROMA_EGRESS_TOKEN_FILE is set/,
    )
  })

  it('reads the gateway, its token, and what the operator adds to the agent’s allowlist', () => {
    expect(
      readEgressEnv({ ...GATEWAY, ROMA_EGRESS_ALLOW: ' PyPI.org , *.pythonhosted.org,' }),
    ).toEqual({
      gateway: { url: 'http://egress:3128', token: TOKEN },
      extra: ['pypi.org', '*.pythonhosted.org'],
    })
  })

  it('refuses a gateway without its token, and a token or allowlist without a gateway', () => {
    expect(problems({ ROMA_EGRESS_GATEWAY: 'http://egress:3128' })).toMatch(
      /ROMA_EGRESS_TOKEN_FILE is not set/,
    )
    expect(problems({ ROMA_EGRESS_TOKEN_FILE: tokenFile })).toMatch(
      /ROMA_EGRESS_GATEWAY is not set/,
    )
    expect(problems({ ROMA_EGRESS_ALLOW: 'pypi.org' })).toMatch(/ROMA_EGRESS_GATEWAY is not set/)
  })

  it('refuses a gateway that is not http://host:port, or carries credentials of its own', () => {
    for (const url of [
      'https://egress:3128',
      'http://egress',
      'http://roma:x@egress:3128',
      'http://egress:3128/p',
      'egress:3128',
    ]) {
      expect(problems({ ...GATEWAY, ROMA_EGRESS_GATEWAY: url }), url).toMatch(
        /not http:\/\/<host>:<port>/,
      )
    }
  })

  it('refuses a token file it cannot read, or one that holds no usable token', () => {
    expect(problems({ ...GATEWAY, ROMA_EGRESS_TOKEN_FILE: join(dir, 'missing') })).toMatch(
      /could not read/,
    )
    expect(problems({ ...GATEWAY, ROMA_EGRESS_TOKEN_FILE: shortFile })).toMatch(/at least 32/)
  })

  it('refuses an allowlist entry that is an address, a port or not a name', () => {
    const message = problems({
      ...GATEWAY,
      ROMA_EGRESS_ALLOW: 'pypi.org,10.0.0.1,example.com:8443,*,localhost',
    })

    for (const bad of ['"10.0.0.1"', '"example.com:8443"', '"*"', '"localhost"'])
      expect(message).toContain(bad)
    expect(message).not.toContain('"pypi.org"')
  })
})

describe('readGatewayEnv', () => {
  it('reads the same token roma does, and a port', () => {
    expect(readGatewayEnv({ ROMA_EGRESS_TOKEN_FILE: tokenFile })).toEqual({
      token: TOKEN,
      port: 3128,
    })
    expect(
      readGatewayEnv({ ROMA_EGRESS_TOKEN_FILE: tokenFile, ROMA_EGRESS_PORT: '8080' }).port,
    ).toBe(8080)
  })

  it('refuses to start without a usable token, since it would then refuse nobody', () => {
    expect(() => readGatewayEnv({})).toThrow(/ROMA_EGRESS_TOKEN_FILE/)
    expect(() => readGatewayEnv({ ROMA_EGRESS_TOKEN_FILE: shortFile })).toThrow(/at least 32/)
    expect(() =>
      readGatewayEnv({ ROMA_EGRESS_TOKEN_FILE: tokenFile, ROMA_EGRESS_PORT: 'x' }),
    ).toThrow(/not a port/)
  })
})
