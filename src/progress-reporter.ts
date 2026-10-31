import type { TaskProgress } from './channel-adapter.js'
import {
  readCompacting,
  readTextDelta,
  readThinkingTokens,
  readToolFinished,
  readToolNames,
  readToolStarted,
  type ClaudeEvent,
} from './stream-events.js'

const PROGRESS_INTERVAL_MS = 5_000

export interface ProgressReporterOptions {
  readonly deliver: (progress: TaskProgress) => void | Promise<void>
  readonly updates?: boolean
}

export class ProgressReporter {
  readonly #deliver: (progress: TaskProgress) => void | Promise<void>
  readonly #updates: boolean

  #current: TaskProgress | null = null
  #sent: TaskProgress | null = null
  #sentAt = 0
  #timer: NodeJS.Timeout | null = null
  #stopped = false
  #sending: Promise<void> = Promise.resolve()
  #characters = 0

  constructor({ deliver, updates = true }: ProgressReporterOptions) {
    this.#deliver = deliver
    this.#updates = updates
  }

  update(progress: TaskProgress): void {
    if (this.#stopped) return
    this.#current = progress
    if (this.#sent === null) {
      this.#send()
      return
    }
    if (!this.#updates) return
    this.#arm()
  }

  observe(event: ClaudeEvent): void {
    const progress = this.#read(event)
    if (progress !== null) this.update(progress)
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  #read(event: ClaudeEvent): TaskProgress | null {
    const text = readTextDelta(event)
    if (text !== '') {
      this.#characters += text.length
      return { phase: 'writing', characters: this.#characters }
    }
    const estimatedTokens = readThinkingTokens(event)
    if (estimatedTokens !== null) return { phase: 'thinking', estimatedTokens }
    const started = readToolStarted(event)
    if (started !== null) return { phase: 'tool', tool: started }
    if (readCompacting(event)) return { phase: 'compacting' }
    if (readToolFinished(event)) {
      return this.#current?.phase === 'tool' ? { phase: 'working' } : null
    }
    const tools = readToolNames(event)
    if (tools.length > 0) return { phase: 'tool', tool: tools.join(', ') }
    return null
  }

  #arm(): void {
    if (this.#timer !== null) return
    const dueIn = this.#sentAt + PROGRESS_INTERVAL_MS - Date.now()
    if (dueIn <= 0) {
      this.#tick()
      return
    }
    const timer = setTimeout(() => {
      this.#timer = null
      this.#tick()
    }, dueIn)
    timer.unref?.()
    this.#timer = timer
  }

  #tick(): void {
    if (this.#stopped || this.#current === null) return
    if (saysTheSame(this.#current, this.#sent)) return
    this.#send()
  }

  #send(): void {
    const progress = this.#current
    if (progress === null) return
    this.#sent = progress
    this.#sentAt = Date.now()
    this.#sending = this.#sending.then(async () => {
      if (this.#stopped) return
      try {
        await this.#deliver(progress)
      } catch {}
    })
  }
}

function saysTheSame(a: TaskProgress, b: TaskProgress | null): boolean {
  if (b === null) return false
  switch (a.phase) {
    case 'queued':
      return b.phase === 'queued' && b.position === a.position
    case 'working':
      return b.phase === 'working'
    case 'compacting':
      return b.phase === 'compacting'
    case 'thinking':
      return b.phase === 'thinking' && b.estimatedTokens === a.estimatedTokens
    case 'tool':
      return b.phase === 'tool' && b.tool === a.tool
    case 'writing':
      return b.phase === 'writing' && b.characters === a.characters
  }
}
