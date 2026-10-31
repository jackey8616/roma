import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appJwt } from './app-jwt.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const NOW = 1_800_000_000_000

function claimsOf(jwt: string): { iat: number; exp: number; iss: string } {
  const payload = jwt.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    iat: number
    exp: number
    iss: string
  }
}

describe('the JWT roma signs as its App', () => {
  const JWT_WHY =
    'The App JWT is backdated a minute, once, and spans nine minutes from `iat` (ADR-0008). ' +
    'Without the backdate a clock a few seconds fast issues a JWT "in the future" and GitHub ' +
    'rejects it; added twice, `exp - iat` reaches the ten-minute maximum GitHub refuses on, ' +
    'a refusal that surfaces as "roma cannot mint" with no hint that time is why (#62).'

  it('signs as the App id', () => {
    expect(claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW })).iss).toBe('12345')
  })

  it('is issued a minute in the past, against a clock that may be fast [fence:github-jwt-backdated-once]', () => {
    expect(claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW })).iat, JWT_WHY).toBe(
      NOW / 1000 - 60,
    )
  })

  it('spans nine of the ten minutes GitHub allows, not all ten [fence:github-jwt-backdated-once]', () => {
    const { iat, exp } = claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW }))

    expect(exp - iat, JWT_WHY).toBe(9 * 60)
    expect(exp - NOW / 1000, JWT_WHY).toBe(8 * 60)
  })

  it('is signed with the private key, RS256', async () => {
    const { createVerify } = await import('node:crypto')
    const jwt = appJwt({ appId: '12345', privateKey: PEM, now: NOW })
    const [header, payload, signature] = jwt.split('.')

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    expect(
      createVerify('RSA-SHA256')
        .update(`${String(header)}.${String(payload)}`)
        .verify(publicKey, Buffer.from(signature ?? '', 'base64url')),
    ).toBe(true)
  })
})
