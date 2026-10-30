import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PendingEnclosure } from './channel-adapter.js'

/** Enforced by `fence:enclosures-out-of-the-agents-way`. */
const DIRECTORY = '.enclosures'

/** An Enclosure once roma has written it down: what the agent is given. */
export interface WrittenEnclosure {
  /** Relative to the Working Directory, and minted here. */
  readonly path: string
  /** What the Channel said the sender called it. Never a path. */
  readonly name: string
  /** Whoever sent it along, where that is not the Caller. Carried from `PendingEnclosure` unchanged. */
  readonly from: string | null
}

/**
 * Redeem every Enclosure on a message and write it into the Working Directory,
 * under `.enclosures/` with a name roma mints. Call it once the Session is
 * known. Each is held in memory once, briefly, for the length of its write.
 *
 * Rejects with `EnclosureUnreadable` on the first Enclosure that cannot be
 * fetched.
 */
export async function writeEnclosures(
  enclosures: readonly PendingEnclosure[],
  cwd: string,
): Promise<readonly WrittenEnclosure[]> {
  if (enclosures.length === 0) return []

  await mkdir(join(cwd, DIRECTORY), { recursive: true })

  const written: WrittenEnclosure[] = []
  for (const enclosure of enclosures) {
    const path = `./${DIRECTORY}/${mintedName(enclosure.name)}`
    let content: Uint8Array
    try {
      content = await enclosure.redeem()
    } catch (error) {
      throw new EnclosureUnreadable(enclosure.name, error)
    }
    await writeFile(join(cwd, path), content)
    written.push({ path, name: enclosure.name, from: enclosure.from })
  }
  return written
}

/**
 * An Enclosure roma was told about and could not fetch. Its own type so the
 * Core can tell the Caller its reason, where any other error gets `reasonFor`'s
 * one sentence about roma having failed.
 *
 * Carries the sender's own name for it, so a message with two says which one.
 */
export class EnclosureUnreadable extends Error {
  readonly enclosureName: string

  constructor(enclosureName: string, cause: unknown) {
    super(`${enclosureName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'EnclosureUnreadable'
    this.enclosureName = enclosureName
  }
}

/** Enforced by `fence:enclosures-name-is-minted`. */
function mintedName(declared: string): string {
  const dot = declared.lastIndexOf('.')
  const suffix = dot === -1 ? '' : declared.slice(dot + 1)
  const extension = /^[A-Za-z0-9]{1,8}$/.test(suffix) ? `.${suffix.toLowerCase()}` : ''
  return `${randomUUID()}${extension}`
}
