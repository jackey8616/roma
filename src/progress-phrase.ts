import type { TaskProgress } from './channel-adapter.js'

export function progressPhrase(progress: TaskProgress): string {
  switch (progress.phase) {
    case 'queued':
      return progress.position === 1 ? 'Queued.' : `Queued — ${progress.position} waiting.`
    case 'working':
      return 'Working…'
    case 'compacting':
      return 'Compacting…'
    case 'thinking':
      return `Thinking… (~${progress.estimatedTokens} tokens)`
    case 'tool':
      return `Running ${progress.tool.slice(0, MAX_TOOL_CHARS)}…`
    case 'writing':
      return `Writing… (${progress.characters} chars)`
  }
}

const MAX_TOOL_CHARS = 120
