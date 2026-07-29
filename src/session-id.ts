import { createHash } from 'node:crypto'

/**
 * roma's uuidv5 namespace. Minted once with `crypto.randomUUID()` and frozen.
 *
 * Every Session id in existence is derived under it, so changing it is not a
 * refactor: it renames every Session at once, orphaning every transcript Claude
 * Code holds on disk and losing the context of every live Conversation. There is
 * no migration, because roma keeps no record mapping the two.
 */
export const ROMA_NAMESPACE = 'd34e4bf8-6828-4829-9f5b-a6f0ce25205f'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Session backing one Conversation.
 *
 * Derived rather than looked up, which is the whole reason roma needs no
 * database: the same Conversation Key reaches the same Session across a restart,
 * a redeploy, or a different machine, with nothing persisted anywhere. What the
 * key *is* belongs to the Channel Adapter that supplied it — the Core's only
 * rule is that it is stable.
 */
export function sessionIdFor(conversationKey: string): string {
  if (conversationKey.trim() === '') {
    throw new Error('a Conversation Key cannot be empty')
  }
  return uuidv5(conversationKey, ROMA_NAMESPACE)
}

/**
 * RFC 9562 version 5: a uuid that is the SHA-1 of a namespace and a name.
 *
 * Written out here rather than taken as a dependency because it is fifteen lines
 * and one published test vector, and because every Session id roma will ever use
 * comes out of it.
 */
export function uuidv5(name: string, namespace: string): string {
  const hash = createHash('sha1')
  hash.update(namespaceBytes(namespace))
  hash.update(Buffer.from(name, 'utf8'))
  const bytes = hash.digest().subarray(0, 16)

  // Version 5 in the high nibble of byte 6, and the RFC 9562 variant (10xx) in
  // the top bits of byte 8. Both overwrite hash bits, which is why the version
  // and variant of a v5 uuid say nothing about the name it came from.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * A namespace uuid as the sixteen bytes it stands for.
 *
 * Hashing the text would produce a different id for the same namespace written
 * in upper case — a difference no reader would ever suspect, and one that would
 * silently orphan every Session derived under the other spelling.
 */
function namespaceBytes(namespace: string): Buffer {
  if (!UUID.test(namespace)) {
    throw new Error(`namespace is not a uuid: ${namespace}`)
  }
  return Buffer.from(namespace.replace(/-/g, ''), 'hex')
}
