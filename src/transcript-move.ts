import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_AT_END = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export interface TranscriptMove {
  readonly moved: readonly string[]
  readonly unattributed: readonly string[]
}

export function projectNameOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function moveTranscripts({
  configDir,
  workRoot,
}: {
  readonly configDir: string
  readonly workRoot: string
}): TranscriptMove {
  const projects = join(configDir, 'projects')
  let entries
  try {
    entries = readdirSync(projects, { withFileTypes: true })
  } catch {
    return { moved: [], unattributed: [] }
  }

  const prefix = projectNameOf(`${workRoot}/`)
  const moved: string[] = []
  const unattributed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionId = entry.name.startsWith(prefix) ? SESSION_AT_END.exec(entry.name)?.[1] : null
    const sessionDir = sessionId == null ? null : join(configDir, 'sessions', sessionId)
    if (
      sessionId == null ||
      sessionDir === null ||
      entry.name !== `${prefix}${sessionId}` ||
      existsSync(sessionDir)
    ) {
      unattributed.push(entry.name)
      continue
    }
    const sessions = join(configDir, 'sessions')
    mkdirSync(sessions, { recursive: true, mode: 0o711 })
    chmodSync(sessions, 0o711)
    mkdirSync(join(sessionDir, 'projects'), { recursive: true, mode: 0o700 })
    renameSync(join(projects, entry.name), join(sessionDir, 'projects', entry.name))
    moved.push(sessionId)
  }
  return { moved, unattributed }
}
