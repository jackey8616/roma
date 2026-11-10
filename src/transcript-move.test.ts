import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moveTranscripts } from './transcript-move.js'

const A = '0a000000-0000-4000-8000-000000000001'
const B = '0b000000-0000-4000-8000-000000000002'

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'roma-transcripts-'))
  roots.push(dir)
  return dir
}

function transcript(config: string, project: string, sessionId: string): string {
  mkdirSync(join(config, 'projects', project), { recursive: true })
  const path = join(config, 'projects', project, `${sessionId}.jsonl`)
  writeFileSync(path, `{"session":"${sessionId}"}\n`)
  return path
}

const WORK = '/var/lib/roma/work'
const projectOf = (sessionId: string) => `-var-lib-roma-work-${sessionId}`

describe('moving each Transcript into its own Session’s config directory', () => {
  it('moves what one shared config directory held into one per Session [fence:transcripts-move-into-their-sessions]', () => {
    const why =
      'ADR-0036: every Session now runs with a CLAUDE_CONFIG_DIR of its own, so a Transcript ' +
      'left in the shared one is a conversation the next --resume cannot find — and one every ' +
      'Seat could otherwise reach. A move, not a copy, so ADR-0006’s no second copy holds.'
    const config = configDir()
    const old = transcript(config, projectOf(A), A)

    const moved = moveTranscripts({ configDir: config, workRoot: WORK })

    const kept = join(config, 'sessions', A, 'projects', projectOf(A), `${A}.jsonl`)
    expect(readFileSync(kept, 'utf8'), why).toContain(A)
    expect(existsSync(old), why).toBe(false)
    expect(moved, why).toEqual({ moved: [A], unattributed: [] })
  })

  it('leaves the directory every Session’s sits in passable by every Seat [fence:transcripts-move-leaves-sessions-passable]', () => {
    const why =
      'ADR-0036: each Seat reaches its own config directory through sessions/, which it may ' +
      'pass through but not list. Made 0700 by the move, no Seat can reach the Transcript it ' +
      'resumes from; the Session’s own directory stays closed to everyone but its owner.'
    const config = configDir()
    transcript(config, projectOf(A), A)

    moveTranscripts({ configDir: config, workRoot: WORK })

    expect(statSync(join(config, 'sessions')).mode & 0o777, why).toBe(0o711)
    expect(statSync(join(config, 'sessions', A)).mode & 0o777, why).toBe(0o700)
  })

  it('leaves a Transcript it cannot attribute to a Session where it is, and says so', () => {
    const config = configDir()
    const elsewhere = transcript(config, '-home-someone-project', B)

    const moved = moveTranscripts({ configDir: config, workRoot: WORK })

    expect(existsSync(elsewhere)).toBe(true)
    expect(moved).toEqual({ moved: [], unattributed: ['-home-someone-project'] })
  })

  it('does not overwrite a Session that already has a config directory of its own', () => {
    const config = configDir()
    const old = transcript(config, projectOf(A), A)
    mkdirSync(join(config, 'sessions', A), { recursive: true })

    const moved = moveTranscripts({ configDir: config, workRoot: WORK })

    expect(existsSync(old)).toBe(true)
    expect(moved).toEqual({ moved: [], unattributed: [projectOf(A)] })
  })

  it('does nothing on a config directory that never had a Transcript', () => {
    expect(moveTranscripts({ configDir: configDir(), workRoot: WORK })).toEqual({
      moved: [],
      unattributed: [],
    })
  })
})
