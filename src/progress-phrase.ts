import type { TaskProgress } from './channel-adapter.js'

/**
 * What a Task is doing, in the words an acknowledgement says it in.
 *
 * The Core's sentence rather than a Channel's: every phrase is a fact about the
 * Turn, and a fact that reads the same wherever it is drawn is one sentence.
 * How a person is addressed, the message's limit and whether it can be edited
 * stay the Channel's.
 *
 * Bounds the tool's command to `MAX_TOOL_CHARS`, which is roma's reading limit
 * and not a Channel's: a Channel still bounds the finished string against its own.
 */
export function progressPhrase(progress: TaskProgress): string {
  switch (progress.phase) {
    case 'queued':
      // The count includes this Task, so 1 means nothing is ahead of it. Said as
      // a number of waiting Tasks rather than as a position, because a Task
      // whose Session is busy is stepped over: this is the size of the backlog,
      // not a place in a running order.
      return progress.position === 1 ? 'Queued.' : `Queued — ${progress.position} waiting.`
    case 'working':
      return 'Working…'
    case 'compacting':
      // Claude Code's own word for it, and the one the person typed if they
      // asked for this. Nothing about how far along: the figures arrive with the
      // boundary, which is the moment it is over.
      return 'Compacting…'
    case 'thinking':
      return `Thinking… (~${progress.estimatedTokens} tokens)`
    case 'tool':
      // Cut mid-character rather than at a word boundary: `Running rm -rf…`
      // reads as a whole command where `Running rm -rf /home/user/proj…` is
      // visibly severed. A clean edge is the point when trimming prose and the
      // lie when quoting a command.
      //
      // The sentence's own `…` carries both meanings at once — the tool is still
      // running, and the command goes on past here. There is no second marker
      // deliberately: a reader who learned how much was cut would do nothing
      // differently with it, and this is read at a glance.
      return `Running ${progress.tool.slice(0, MAX_TOOL_CHARS)}…`
    case 'writing':
      // Enforced by `fence:progress-writing-carries-no-prose`.
      return `Writing… (${progress.characters} chars)`
  }
}

const MAX_TOOL_CHARS = 120
