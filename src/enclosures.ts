import { randomUUID } from 'node:crypto'
import type { PendingEnclosure } from './channel-adapter.js'

export const ENCLOSURE_DIRECTORY = '.enclosures'

export type Enclose = (name: string, content: Uint8Array) => Promise<void>

export interface WrittenEnclosure {
  readonly path: string
  readonly name: string
  readonly from: string | null
}

export async function writeEnclosures(
  enclosures: readonly PendingEnclosure[],
  enclose: Enclose,
): Promise<readonly WrittenEnclosure[]> {
  const redeemed: { readonly enclosure: PendingEnclosure; readonly content: Uint8Array }[] = []
  for (const enclosure of enclosures) {
    try {
      redeemed.push({ enclosure, content: await enclosure.redeem() })
    } catch (error) {
      throw new EnclosureUnreadable(enclosure.name, error)
    }
  }

  const written: WrittenEnclosure[] = []
  for (const { enclosure, content } of redeemed) {
    const minted = mintedName(enclosure.name)
    await enclose(minted, content)
    written.push({
      path: `./${ENCLOSURE_DIRECTORY}/${minted}`,
      name: enclosure.name,
      from: enclosure.from,
    })
  }
  return written
}

export class EnclosureUnreadable extends Error {
  readonly enclosureName: string

  constructor(enclosureName: string, cause: unknown) {
    super(`${enclosureName}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'EnclosureUnreadable'
    this.enclosureName = enclosureName
  }
}

function mintedName(declared: string): string {
  const dot = declared.lastIndexOf('.')
  const suffix = dot === -1 ? '' : declared.slice(dot + 1)
  const extension = /^[A-Za-z0-9]{1,8}$/.test(suffix) ? `.${suffix.toLowerCase()}` : ''
  return `${randomUUID()}${extension}`
}
