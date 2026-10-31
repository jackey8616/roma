import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HEADING = /^#\s+(\d+)\.\s/m

describe('every ADR has its own number', () => {
  it('gives no number to two files', () => {
    const byNumber = new Map<number, string[]>()

    for (const { file, number } of adrs()) {
      const n = Number(number)
      byNumber.set(n, [...(byNumber.get(n) ?? []), file])
    }

    const shared = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${number}: ${files.join(', ')}`)

    expect(shared).toEqual([])
  })

  it('numbers each file the same way in its name and in its heading', () => {
    const disagreements = adrs()
      .map(({ file, number, source }) => {
        const heading = HEADING.exec(source)?.[1]

        return heading === undefined
          ? `${file}: no '# N.' heading`
          : Number(heading) === Number(number)
            ? undefined
            : `${file}: heading says ${heading}`
      })
      .filter((problem) => problem !== undefined)

    expect(disagreements).toEqual([])
  })
})

function adrs(): { file: string; number: string; source: string }[] {
  const path = fromRoot('docs/adr')

  return readdirSync(path)
    .filter((file) => file.endsWith('.md'))
    .map((file) => ({ file, number: /^(\d+)-/.exec(file)?.[1] }))
    .filter((adr): adr is { file: string; number: string } => adr.number !== undefined)
    .map((adr) => ({ ...adr, source: readFileSync(join(path, adr.file), 'utf8') }))
}

function fromRoot(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url))
}
