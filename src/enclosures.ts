import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PendingEnclosure } from './channel-adapter.js'

const DIRECTORY = '.enclosures'

export interface WrittenEnclosure {
  readonly path: string
  readonly name: string
  readonly from: string | null
}

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
