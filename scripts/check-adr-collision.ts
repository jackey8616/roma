import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collisionMessage, collisionsOnMerge } from './adr-collision.js'

const ADR_DIRECTORY = 'docs/adr'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  main()
} catch (error) {
  console.error(`adr collision check failed: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

function main(): void {
  const base = process.env.GITHUB_BASE_REF

  if (base === undefined || base === '') {
    console.log('no base branch in the environment — nothing is being merged, so nothing to check')
    return
  }

  const head = process.env.ADR_HEAD_SHA ?? 'HEAD'

  const baseTip = fetchBaseTip(base)

  const collisions = collisionsOnMerge({
    mergeBase: adrsAt(mergeBaseOf(baseTip, head)),
    base: adrsAt(baseTip),
    head: adrsAt(head),
  })

  if (collisions.length === 0) {
    console.log(`no ADR number is shared between this branch and ${base}`)
    return
  }

  throw new Error(collisionMessage(collisions, base))
}

function fetchBaseTip(base: string): string {
  git(['fetch', '--no-tags', 'origin', base])
  return 'FETCH_HEAD'
}

function mergeBaseOf(base: string, head: string): string {
  try {
    return git(['merge-base', base, head])
  } catch {
    throw new Error(
      `no common ancestor of ${base} and ${head}. A shallow clone is the usual cause — ` +
        'the checkout needs `fetch-depth: 0`.',
    )
  }
}

function adrsAt(commit: string): string[] {
  return git(['ls-tree', '--name-only', '-r', commit, '--', ADR_DIRECTORY])
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => path.slice(`${ADR_DIRECTORY}/`.length))
}

function git(argv: string[]): string {
  return execFileSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}
