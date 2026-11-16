import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDrift, type DriftIo } from './check-pin-drift.js'
import { pinNamed } from './pin-drift.js'

const LOUD =
  'The drift check must end red when the question could not be asked — no Dockerfile, a ' +
  'registry that answered an error or did not answer, a grep that failed — and be quiet only ' +
  'when the pin and the registry agree (ADR-0007, #52). A check that swallowed its own I/O ' +
  'failures would pass forever while watching nothing.'

const CASES = [
  {
    name: 'claude-code',
    pkg: '@anthropic-ai/claude-code',
    dockerfile: 'ARG CLAUDE_CODE_VERSION=2.1.220\nARG CODEX_VERSION=0.160.1\nFROM node:22-slim\n',
    pinned: '2.1.220',
    published: '2.1.221',
  },
  {
    name: 'codex',
    pkg: '@openai/codex',
    dockerfile: 'ARG CLAUDE_CODE_VERSION=2.1.221\nARG CODEX_VERSION=0.160.0\nFROM node:22-slim\n',
    pinned: '0.160.0',
    published: '0.160.1',
  },
] as const

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

describe.each(CASES)(
  'the $name drift check fails loud on its own I/O [fence:drift-io-fails-loud]',
  (c) => {
    const pin = pinNamed(c.name)
    const asked: string[] = []

    function io(overrides: Partial<DriftIo> = {}, version: string = c.pinned): DriftIo {
      return {
        root,
        fetch: async (url) => {
          asked.push(String(url))
          return new Response(JSON.stringify({ version }), { status: 200 })
        },
        grep: () => './Dockerfile\n',
        ...overrides,
      }
    }

    it('rejects when there is no Dockerfile to read the pin from', async () => {
      await expect(checkDrift(pin, io()), LOUD).rejects.toThrow(/ENOENT/)
    })

    it('rejects when the registry answers an error status', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)
      const notFound = async () => new Response('{"error":"Not found"}', { status: 404 })

      await expect(checkDrift(pin, io({ fetch: notFound })), LOUD).rejects.toThrow(/404/)
    })

    it('rejects when the registry cannot be reached', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)
      const offline = async () => {
        throw new TypeError('fetch failed')
      }

      await expect(checkDrift(pin, io({ fetch: offline })), LOUD).rejects.toThrow(/fetch failed/)
    })

    it('rejects when grep fails at its job, rather than reporting no evidence', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)
      const broken = () => {
        throw Object.assign(new Error('grep: invalid option'), { status: 2 })
      }

      await expect(checkDrift(pin, io({ grep: broken }, c.published)), LOUD).rejects.toThrow(/grep/)
    })

    it('asks the registry about its own package', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)
      asked.length = 0

      await checkDrift(pin, io())

      expect(asked).toEqual([`https://registry.npmjs.org/${c.pkg}/latest`])
    })

    it('says nothing to file when the pin and the registry agree', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)

      await checkDrift(pin, io())

      expect(readFileSync(outputs, 'utf8')).toBe('drift=false\n')
    })

    it('files a report under its own label when they differ', async () => {
      writeFileSync(join(root, 'Dockerfile'), c.dockerfile)

      await checkDrift(pin, io({}, c.published))

      const written = readFileSync(outputs, 'utf8')
      expect(written).toMatch(/^drift=true\n/)
      expect(written).toContain(`\nlabel=${c.name}-drift\n`)
      expect(written).toContain(`\nbody_file=${join(root, `${c.name}-drift.md`)}\n`)
    })
  },
)
