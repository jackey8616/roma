import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Source {
  readonly file: string
  readonly source: string
}

export function sources(): Source[] {
  const src = fileURLToPath(new URL('../../src/', import.meta.url))
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(src, file), 'utf8') }))
}

export const COMPOSITION_ROOTS = [['channels', 'main.ts'].join(sep)]

export function containment(
  directory: string,
  alsoBound: readonly string[] = [],
): { inside: Source[]; outside: Source[] } {
  const under = (source: Source, dir: string) => source.file.split(sep).includes(dir)
  const owns = (source: Source) => under(source, directory)
  const all = sources()
  return {
    inside: all.filter(owns),
    outside: all.filter(
      (source) =>
        !owns(source) &&
        !alsoBound.some((dir) => under(source, dir)) &&
        !COMPOSITION_ROOTS.includes(source.file),
    ),
  }
}

export function matching(
  sources: readonly Source[],
  patterns: readonly RegExp[],
): readonly Source[] {
  return sources.filter(({ source }) => patterns.some((pattern) => pattern.test(code(source))))
}

export function code(source: string): string {
  let inBlock = false
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      if (inBlock) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/')
        return false
      }
      return !trimmed.startsWith('//')
    })
    .join('\n')
}
