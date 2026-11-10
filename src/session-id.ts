import { createHash } from 'node:crypto'

export const ROMA_NAMESPACE = 'd34e4bf8-6828-4829-9f5b-a6f0ce25205f'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const GENERATION_SEPARATOR = '\u0000'

export function sessionIdFor(conversationKey: string, generation = 0): string {
  if (conversationKey.trim() === '') {
    throw new Error('a Conversation Key cannot be empty')
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`a Session generation counts from zero: ${generation}`)
  }
  const name =
    generation === 0 ? conversationKey : `${conversationKey}${GENERATION_SEPARATOR}${generation}`
  return uuidv5(name, ROMA_NAMESPACE)
}

export function uuidv5(name: string, namespace: string): string {
  const hash = createHash('sha1')
  hash.update(namespaceBytes(namespace))
  hash.update(Buffer.from(name, 'utf8'))
  const bytes = hash.digest().subarray(0, 16)

  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function namespaceBytes(namespace: string): Buffer {
  if (!UUID.test(namespace)) {
    throw new Error(`namespace is not a uuid: ${namespace}`)
  }
  return Buffer.from(namespace.replace(/-/g, ''), 'hex')
}
