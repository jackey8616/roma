import { createSign } from 'node:crypto'

const LIFETIME_S = 9 * 60

const BACKDATED_S = 60

export interface AppJwtOptions {
  readonly appId: string
  readonly privateKey: string
  readonly now?: number
}

export function appJwt({ appId, privateKey, now = Date.now() }: AppJwtOptions): string {
  const issuedAt = Math.floor(now / 1000) - BACKDATED_S
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat: issuedAt, exp: issuedAt + LIFETIME_S, iss: appId }

  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signed).sign(privateKey)
  return `${signed}.${base64url(signature)}`
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}
