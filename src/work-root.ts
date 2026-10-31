import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const WORK_DIR_TTL_MS = 7 * 24 * 60 * 60_000

const GENERATION_SUFFIX = '.generation'

const MODEL_SUFFIX = '.model'

const EFFORT_SUFFIX = '.effort'

const CAVEMAN_SUFFIX = '.caveman'

const OPENED_SUFFIX = '.opened'

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export interface Reclaimed {
  readonly sessionId: string
  readonly cwd: string
  readonly idleMs: number
}

export class WorkRoot {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  sessionDir(sessionId: string): string {
    return join(this.#root, sessionId)
  }

  touch(sessionId: string): void {
    const seconds = Date.now() / 1000
    try {
      utimesSync(this.sessionDir(sessionId), seconds, seconds)
    } catch {}
  }

  reclaimIdle(inUse: ReadonlySet<string>): readonly Reclaimed[] {
    let entries
    try {
      entries = readdirSync(this.#root, { withFileTypes: true })
    } catch {
      return []
    }

    const now = Date.now()
    const reclaimed: Reclaimed[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionId = entry.name
      if (inUse.has(sessionId)) continue

      const cwd = this.sessionDir(sessionId)
      let idleMs: number
      try {
        idleMs = now - statSync(cwd).mtimeMs
      } catch {
        continue
      }
      if (idleMs < WORK_DIR_TTL_MS) continue

      rmSync(cwd, { recursive: true, force: true })
      reclaimed.push({ sessionId, cwd, idleMs })
    }
    return reclaimed
  }

  generationRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${GENERATION_SUFFIX}`)
  }

  modelRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${MODEL_SUFFIX}`)
  }

  effortRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${EFFORT_SUFFIX}`)
  }

  cavemanRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${CAVEMAN_SUFFIX}`)
  }

  openedRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${OPENED_SUFFIX}`)
  }

  readRecord(path: string): string | null {
    let contents: string
    try {
      contents = readFileSync(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    return contents.trim()
  }

  writeRecord(path: string, contents: string): void {
    mkdirSync(this.#root, { recursive: true })
    const pending = `${path}.pending`
    writeFileSync(pending, contents, 'utf8')
    renameSync(pending, path)
  }

  forgetRecord(path: string): void {
    rmSync(path, { force: true })
  }
}
