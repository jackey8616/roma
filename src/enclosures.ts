import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PendingEnclosure } from './channel-adapter.js'

/**
 * Where Enclosures live inside a Working Directory.
 *
 * A subdirectory rather than the root, because the root is the agent's: ADR-0008
 * has it cloning what it was asked about, and a file dropped beside a clone is a
 * file somebody has to work out the provenance of. Dot-prefixed so that it
 * cannot collide with a repository of the same name and so it stays out of the
 * agent's way in a listing — discovery is not the point, since every Enclosure's
 * path is named to the agent explicitly.
 */
const DIRECTORY = '.enclosures'

/**
 * An Enclosure once roma has written it down.
 *
 * The pair the agent is given: where roma put it, and what the person who sent
 * it called it. Two fields rather than one because they have opposite
 * provenance — the path is roma's and can be trusted to be a path, the name is
 * the sender's and is only ever printed (ADR-0011).
 */
export interface WrittenEnclosure {
  /** Relative to the Working Directory, and minted here. */
  readonly path: string
  /** What the Channel said the sender called it. Never a path. */
  readonly name: string
  /**
   * Whoever sent it along, where that is not the Caller. Carried across from
   * `PendingEnclosure` unchanged, and printed for the same reason the name is.
   */
  readonly from: string | null
}

/**
 * Redeem every Enclosure on a message and write it into the Working Directory.
 *
 * Called once the Session is known and immediately before the Turn — which is
 * the whole of ADR-0011's argument for a `PendingEnclosure`: the bytes are
 * sized by whoever sent the message, so they are held for the length of a write
 * rather than across queueing, Parking and a possible `/stop`.
 *
 * Held, not streamed. `redeem` yields a `Uint8Array`, so an Enclosure is in
 * memory once, briefly, here. A streaming redemption would be faithful to the
 * word ADR-0011 used and would cost every Adapter a stream to produce; the
 * decision that ADR actually argued was *when*, and this is that. Worth
 * revisiting if a Channel ever carries something big enough for the difference
 * to matter, which is the same moment the deferred size policy comes due.
 *
 * Rejects on the first Enclosure that cannot be fetched. The Task then ends as
 * a failure with the reason, which for a Channel with an unreachable class of
 * attachment — Chat's `driveDataRef` — is the normal path and not an edge case.
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
 * An Enclosure roma was told about and could not fetch.
 *
 * A type of its own because the Core says nothing to a Conversation about an
 * error it cannot name: `reasonFor` answers everything else with one sentence
 * about roma having failed, which is right for a fault inside roma and wrong
 * here. What failed is *their* attachment, they are the only person who can do
 * anything about it, and for a Channel with an unreachable class of attachment
 * this is the ordinary outcome rather than a fault at all.
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

/**
 * A filename roma chose, carrying nothing of the sender's but the extension.
 *
 * The name is minted rather than taken because `contentName` is chosen by
 * whoever sent the message: used as a path it is a traversal, a collision
 * between two people sending `screenshot.png` into one Conversation, and
 * whatever a filesystem makes of 200 characters of Unicode. A UUID is none of
 * those things, and what the sender called it is not lost — it rides beside the
 * path as a string (see `WrittenEnclosure`).
 *
 * The extension is the one thing carried across, because tools dispatch on it
 * and an image called `.bin` may simply not be read as one. It is carried under
 * a whitelist rather than sanitised: a bounded charset and a bounded length
 * cannot express a separator, a parent, or a leading dot, so there is nothing
 * left to strip. Anything that does not match gets no extension at all, which
 * is a worse read for the agent and never a worse file for roma.
 */
function mintedName(declared: string): string {
  const dot = declared.lastIndexOf('.')
  const suffix = dot === -1 ? '' : declared.slice(dot + 1)
  const extension = /^[A-Za-z0-9]{1,8}$/.test(suffix) ? `.${suffix.toLowerCase()}` : ''
  return `${randomUUID()}${extension}`
}
