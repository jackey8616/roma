import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { driftReport, pinnedClaudeCode, publishedClaudeCode } from './claude-code-drift.js'

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'

export interface DriftIo {
  readonly root: string
  readonly fetch: typeof fetch
  readonly grep: (pinned: string, root: string) => string
}

const REAL_IO: DriftIo = {
  root: fileURLToPath(new URL('..', import.meta.url)),
  fetch: (...args) => fetch(...args),
  grep: (pinned, root) =>
    execFileSync(
      'grep',
      ['-rlIF', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', pinned, '.'],
      { cwd: root, encoding: 'utf8' },
    ),
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkDrift()
  } catch (error) {
    console.error(
      `claude-code drift check failed: ${error instanceof Error ? error.message : error}`,
    )
    process.exit(1)
  }
}

export async function checkDrift(io: DriftIo = REAL_IO): Promise<void> {
  const pinned = pinnedClaudeCode(readFileSync(join(io.root, 'Dockerfile'), 'utf8'))
  const published = publishedClaudeCode(await registryDocument(io))

  if (pinned === published) {
    console.log(`the pin and the registry agree on ${pinned} — nothing to report`)
    writeStepOutputs({ drift: 'false' })
    return
  }

  const report = driftReport({ pinned, published, evidence: evidenceFor(pinned, io) })

  const path = join(process.env.RUNNER_TEMP ?? tmpdir(), 'claude-code-drift.md')
  writeFileSync(path, report.body)

  console.log(`pinned ${pinned}, published ${published} — report written to ${path}`)

  writeStepOutputs({ drift: 'true', title: report.title, body_file: path })
}

async function registryDocument(io: DriftIo): Promise<unknown> {
  const response = await io.fetch(REGISTRY)

  if (!response.ok) {
    throw new Error(`${REGISTRY} answered ${response.status} ${response.statusText}`)
  }

  return await response.json()
}

function evidenceFor(pinned: string, io: DriftIo): string[] {
  let found = ''

  try {
    found = io.grep(pinned, io.root)
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error
  }

  return found
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\.\//, ''))
    .sort()
}

function writeStepOutputs(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`)
  const path = process.env.GITHUB_OUTPUT

  if (path === undefined) {
    process.stdout.write(lines.join(''))
    return
  }

  appendFileSync(path, lines.join(''))
}
