import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDrift, type DriftIo } from './check-claude-code-drift.js'

const DOCKERFILE = 'ARG CLAUDE_CODE_VERSION=2.1.220\nFROM node:22-slim\n'

const LOUD =
  'The drift check must end red when the question could not be asked — no Dockerfile, a ' +
  'registry that answered an error or did not answer, a grep that failed — and be quiet only ' +
  'when the pin and the registry agree (ADR-0007, #52). A check that swallowed its own I/O ' +
  'failures would pass forever while watching nothing.'

let root: string
let outputs: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-'))
  outputs = join(root, 'github-output')
  writeFileSync(outputs, '')
  vi.stubEnv('GITHUB_OUTPUT', outputs)
  vi.stubEnv('RUNNER_TEMP', root)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** An I/O whose registry answers `version`, and whose grep finds the Dockerfile. */
function io(overrides: Partial<DriftIo> = {}, version = '2.1.220'): DriftIo {
  return {
    root,
    fetch: async () => new Response(JSON.stringify({ version }), { status: 200 }),
    grep: () => './Dockerfile\n',
    ...overrides,
  }
}

describe('the drift check fails loud on its own I/O [fence:drift-io-fails-loud]', () => {
  it('rejects when there is no Dockerfile to read the pin from', async () => {
    await expect(checkDrift(io()), LOUD).rejects.toThrow(/ENOENT/)
  })

  it('rejects when the registry answers an error status', async () => {
    writeFileSync(join(root, 'Dockerfile'), DOCKERFILE)
    const notFound = async () => new Response('{"error":"Not found"}', { status: 404 })

    await expect(checkDrift(io({ fetch: notFound })), LOUD).rejects.toThrow(/404/)
  })

  it('rejects when the registry cannot be reached', async () => {
    writeFileSync(join(root, 'Dockerfile'), DOCKERFILE)
    const offline = async () => {
      throw new TypeError('fetch failed')
    }

    await expect(checkDrift(io({ fetch: offline })), LOUD).rejects.toThrow(/fetch failed/)
  })

  it('rejects when grep fails at its job, rather than reporting no evidence', async () => {
    writeFileSync(join(root, 'Dockerfile'), DOCKERFILE)
    const broken = () => {
      throw Object.assign(new Error('grep: invalid option'), { status: 2 })
    }

    await expect(checkDrift(io({ grep: broken }, '2.1.221')), LOUD).rejects.toThrow(/grep/)
  })

  it('says nothing to file when the pin and the registry agree', async () => {
    writeFileSync(join(root, 'Dockerfile'), DOCKERFILE)

    await checkDrift(io())

    expect(readFileSync(outputs, 'utf8')).toBe('drift=false\n')
  })

  it('files a report when they differ', async () => {
    writeFileSync(join(root, 'Dockerfile'), DOCKERFILE)

    await checkDrift(io({}, '2.1.221'))

    expect(readFileSync(outputs, 'utf8')).toMatch(/^drift=true\n/)
  })
})
