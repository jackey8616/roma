/**
 * Fails when an ADR names a check that does not exist, or when two test files
 * claim one fence name. The judgement is in `scripts/adr-enforcers.ts` and
 * `scripts/fence-names.ts`.
 *
 *   usage: npm run check:adr-enforcers
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { danglingEnforcers, danglingMessage } from './adr-enforcers.js'
import { claimedTwiceMessage, ENFORCED_BY, fencesIn } from './fence-names.js'
import { rules } from './lint/plugin.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, 'docs/adr')

const adrs = readdirSync(dir)
  .filter((file) => file.endsWith('.md'))
  .map((file) => ({ file: `docs/adr/${file}`, text: readFileSync(join(dir, file), 'utf8') }))

const fences = fencesIn(root, Object.keys(rules))

if (fences.claimedTwice.size > 0) {
  console.error(claimedTwiceMessage(fences.claimedTwice))
  process.exit(1)
}

const dangling = danglingEnforcers(adrs, fences)

if (dangling.length > 0) {
  console.error(danglingMessage(dangling))
  process.exit(1)
}

const cited = adrs.reduce((n, { text }) => n + [...text.matchAll(ENFORCED_BY)].length, 0)
console.log(`every one of ${cited} "Enforced by" in docs/adr/ names a check that exists`)
