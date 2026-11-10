import {
  existsSync,
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

const USED_SUFFIX = '.used'

const SPAWNED_SUFFIX = '.spawned'

const LEGACY_SPAWN_FILE = '.roma-session'

export type RemoveWorkDir = (sessionId: string, cwd: string) => Promise<void>

const removeDirectly: RemoveWorkDir = async (_sessionId, cwd) => {
  rmSync(cwd, { recursive: true, force: true })
}

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
  readonly #remove: RemoveWorkDir

  constructor(root: string, remove: RemoveWorkDir = removeDirectly) {
    this.#root = root
    this.#remove = remove
  }

  get root(): string {
    return this.#root
  }

  sessionDir(sessionId: string): string {
    return join(this.#root, sessionId)
  }

  touch(sessionId: string): void {
    const record = this.#usedRecord(sessionId)
    const seconds = Date.now() / 1000
    try {
      utimesSync(record, seconds, seconds)
    } catch {
      try {
        this.writeRecord(record, '')
      } catch {}
    }
  }

  hasSpawned(sessionId: string): boolean {
    return (
      existsSync(this.#spawnedRecord(sessionId)) ||
      existsSync(join(this.sessionDir(sessionId), LEGACY_SPAWN_FILE))
    )
  }

  markSpawned(sessionId: string): void {
    this.writeRecord(this.#spawnedRecord(sessionId), '')
  }

  async reclaimIdle(inUse: ReadonlySet<string>): Promise<readonly Reclaimed[]> {
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
      const idleMs = now - this.#lastUsedMs(sessionId, cwd)
      if (Number.isNaN(idleMs) || idleMs < WORK_DIR_TTL_MS) continue

      await this.#remove(sessionId, cwd)
      this.forgetRecord(this.#usedRecord(sessionId))
      this.forgetRecord(this.#spawnedRecord(sessionId))
      reclaimed.push({ sessionId, cwd, idleMs })
    }
    return reclaimed
  }

  #lastUsedMs(sessionId: string, cwd: string): number {
    for (const path of [this.#usedRecord(sessionId), cwd]) {
      try {
        return statSync(path).mtimeMs
      } catch {}
    }
    return Number.NaN
  }

  #usedRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${USED_SUFFIX}`)
  }

  #spawnedRecord(sessionId: string): string {
    return join(this.#root, `${sessionId}${SPAWNED_SUFFIX}`)
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
    writeFileSync(pending, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(pending, path)
  }

  forgetRecord(path: string): void {
    rmSync(path, { force: true })
  }
}
