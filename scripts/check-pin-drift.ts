import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  driftReport,
  labelFor,
  pinNamed,
  pinnedVersion,
  publishedVersion,
  type Pin,
} from './pin-drift.js'

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
    await checkDrift(pinNamed(process.argv[2]))
  } catch (error) {
    console.error(`drift check failed: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}

export async function checkDrift(pin: Pin, io: DriftIo = REAL_IO): Promise<void> {
  const pinned = pinnedVersion(pin, readFileSync(join(io.root, 'Dockerfile'), 'utf8'))
  const published = publishedVersion(pin, await registryDocument(pin, io))

  if (pinned === published) {
    console.log(`the pin and the registry agree on ${pin.runtime} ${pinned} — nothing to report`)
    writeStepOutputs({ drift: 'false' })
    return
  }

  const report = driftReport(pin, { pinned, published, evidence: evidenceFor(pinned, io) })

  const path = join(process.env.RUNNER_TEMP ?? tmpdir(), `${pin.name}-drift.md`)
  writeFileSync(path, report.body)

  console.log(
    `${pin.runtime}: pinned ${pinned}, published ${published} — report written to ${path}`,
  )

  const { label, description } = labelFor(pin)
  writeStepOutputs({
    drift: 'true',
    title: report.title,
    body_file: path,
    label,
    label_description: description,
  })
}

async function registryDocument(pin: Pin, io: DriftIo): Promise<unknown> {
  const registry = `https://registry.npmjs.org/${pin.npmPackage}/latest`
  const response = await io.fetch(registry)

  if (!response.ok) {
    throw new Error(`${registry} answered ${response.status} ${response.statusText}`)
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
