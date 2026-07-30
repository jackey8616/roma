import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appJwt } from './app-jwt.js'

/**
 * The JWT, read back apart from its signature.
 *
 * What is asserted is the arithmetic and the claims, because those are the two
 * things GitHub refuses on and the two things nothing else in roma would notice
 * were wrong: a token more than ten minutes long, or one issued in the future
 * against a clock a few seconds fast, is rejected — and the failure surfaces as
 * "roma cannot mint" with no hint that time is the reason.
 *
 * The key is generated here rather than fixtured. It is a real RSA key, so the
 * signature is a real signature; what it is not is a secret anybody has to be
 * careful with.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** Noon, as a round number, so the arithmetic reads. */
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
  it('signs as the App id', () => {
    expect(claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW })).iss).toBe('12345')
  })

  // GitHub's own guidance, and the reason is a clock that is a few seconds fast:
  // a JWT issued "in the future" is rejected outright.
  it('is issued a minute in the past, against a clock that may be fast', () => {
    expect(claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW })).iat).toBe(
      NOW / 1000 - 60,
    )
  })

  // Ten minutes is the documented maximum and roma stays a minute inside it, so
  // that the same drift the backdating allows for cannot push `exp` past the
  // limit from the other end.
  it('expires inside the ten minutes GitHub allows', () => {
    const { iat, exp } = claimsOf(appJwt({ appId: '12345', privateKey: PEM, now: NOW }))

    expect(exp - iat).toBeLessThanOrEqual(10 * 60)
    expect(exp - NOW / 1000).toBeGreaterThan(8 * 60)
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
