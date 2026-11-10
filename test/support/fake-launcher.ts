import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnClaudeProcess } from '../../src/claude-process.js'
import type { Launcher, LauncherRoots } from '../../src/launcher.js'

export interface Enclosed {
  readonly seat: number
  readonly sessionId: string
  readonly name: string
}

export class FakeLauncher implements Launcher {
  readonly spawn: SpawnClaudeProcess
  readonly enclosed: Enclosed[] = []
  readonly reclaimed: string[] = []
  readonly calls: string[] = []
  roots: LauncherRoots | null = null

  readonly #workRoot: string
  readonly #failing: ReadonlySet<string>

  constructor(
    workRoot: string,
    spawn: SpawnClaudeProcess,
    { failing = [] }: { readonly failing?: readonly string[] } = {},
  ) {
    this.#workRoot = workRoot
    this.spawn = spawn
    this.#failing = new Set(failing)
  }

  writeRoots(roots: LauncherRoots): void {
    this.#called('roots')
    this.roots = roots
  }

  async sweep(): Promise<void> {
    this.#called('sweep')
  }

  async handOutSockets(): Promise<void> {
    this.#called('seats')
  }

  async enclose(seat: number, sessionId: string, name: string, content: Uint8Array): Promise<void> {
    this.#called('enclose')
    const directory = join(this.#workRoot, sessionId, '.enclosures')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, name), content)
    this.enclosed.push({ seat, sessionId, name })
  }

  async reclaim(sessionId: string): Promise<void> {
    this.#called('reclaim')
    rmSync(join(this.#workRoot, sessionId), { recursive: true, force: true })
    this.reclaimed.push(sessionId)
  }

  #called(mode: string): void {
    this.calls.push(mode)
    if (this.#failing.has(mode)) throw new Error(`roma-launch ${mode} failed (exit 77): refused`)
  }
}
