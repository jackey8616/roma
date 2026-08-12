import type { TaskProgress } from './channel-adapter.js'

/**
 * What a Task is doing, in the words an acknowledgement says it in.
 *
 * **The Core's sentence rather than a Channel's, on the argument a failure's
 * reason is the Core's too**: every one of these is a fact about the Turn — which
 * phase, how many tokens, which tool, how much has been written — and a fact that
 * reads the same wherever it is drawn is one sentence rather than one per
 * Channel. What stays the Channel's is everything about the message it goes in:
 * how a person is addressed in it, what its limit is, and whether it can be
 * edited at all. A Channel that wants other words is free to write them; two
 * that arrived at the same ones were writing this.
 *
 * Deliberately short. The message this goes in is edited every few seconds while
 * a Task runs, so it is read at a glance and never read twice — everything worth
 * keeping is in the Result (ADR-0010).
 *
 * Every phrase is a fixed sentence around a small number except the tool's,
 * which is named by Claude Code's own description of what is running and is
 * therefore the only one with no length of roma's own. `MAX_TOOL_CHARS` is a
 * judgement rather than a measurement — behind it are two recorded
 * `task_started` descriptions at 8 and 56 characters, which says the ordinary
 * case is never cut and says nothing about the tail. It bounds the command
 * alone, and a Channel is still expected to bound the finished string against
 * its own limit: that one is somebody else's hard number where a character over
 * is a refused message, and this one is roma's own reading limit.
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
      // Never the prose: shown here it says what the Result is about to say,
      // seconds later and one message down (ADR-0010). The number is what is
      // left, and it is what keeps a writing Turn from reading as a dead one.
      return `Writing… (${progress.characters} chars)`
  }
}

/** How much of a tool's command an acknowledgement quotes. See `progressPhrase`. */
const MAX_TOOL_CHARS = 120
