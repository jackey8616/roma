import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One source file: its path relative to `src/`, and what is in it. */
export interface Source {
  readonly file: string
  readonly source: string
}

/**
 * Every source file under `src/`, tests excluded, read.
 *
 * Two of roma's claims are about the tree rather than about behaviour — the Core
 * never names a Channel, and nothing anywhere provisions — and both are kept by
 * reading the sources and failing on a denylist. This is the reading part, in
 * one place, so that a test policing a claim is the denylist and the reason for
 * it and nothing else.
 *
 * Deliberately unfiltered. Each caller narrows to the files its own claim binds,
 * which differ: the Channel-name rule stops at `src/channels/`, and the
 * provisioning rule does not.
 */
export function sources(): Source[] {
  const src = fileURLToPath(new URL('../../src/', import.meta.url))
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, source: readFileSync(join(src, file), 'utf8') }))
}
