import { afterAll } from 'vitest'
import type { Credential } from '../../src/build-env.js'
import { CredentialProxy, type Fronted } from '../../src/credential-proxy.js'

const proxy = await CredentialProxy.listen()
afterAll(() => proxy.close())

export function fronted(credential: Credential): Fronted {
  return proxy.front(credential)
}
