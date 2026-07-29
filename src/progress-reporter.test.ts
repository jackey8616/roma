import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskProgress } from './channel-adapter.js'
import { ProgressReporter, type ProgressReporterOptions } from './progress-reporter.js'
import type { ClaudeEvent } from './stream-events.js'
import { flush } from '../test/support/fake-claude.js'
import { ofKind, recordedStream } from '../test/support/recorded-stream.js'

/** The 72-second generating Turn: 194 `text_delta` events and no tool at all. */
const GENERATION = recordedStream('generation-partial-messages').turn(1)
/** The tool-using Turn: a thinking block, a `Bash` call, and 25 seconds of silence. */
const TOOL = recordedStream('tool-use-partial-messages').turn(1)

const INTERVAL = 5_000

function newReporter(options: Partial<ProgressReporterOptions> = {}) {
  const sent: TaskProgress[] = []
  const reporter = new ProgressReporter({
    deliver: (progress) => {
      sent.push(progress)
    },
    ...options,
  })
  return { reporter, sent }
}

/** Acknowledge, then hand the reporter a stretch of a recorded Turn. */
async function acknowledgeAnd(
  reporter: ProgressReporter,
  events: readonly ClaudeEvent[],
): Promise<void> {
  reporter.update({ phase: 'working' })
  for (const event of events) reporter.observe(event)
  await flush()
}

/** The content blocks of an `assistant` event, read straight out of the capture. */
function blocks(event: ClaudeEvent): Record<string, unknown>[] {
  const content = (event['message'] as Record<string, unknown> | undefined)?.['content']
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

/** The `assistant` event carrying the tool call — how a tool window opens. */
const ASKS_FOR_A_TOOL = ofKind(TOOL, 'assistant').find((event) =>
  blocks(event).some((block) => block['type'] === 'tool_use'),
) as ClaudeEvent
const TOOL_STARTED = ofKind(TOOL, 'system/task_started')[0] as ClaudeEvent
const TOOL_FINISHED = ofKind(TOOL, 'system/task_notification')[0] as ClaudeEvent
const THINKING = ofKind(TOOL, 'system/thinking_tokens')[0] as ClaudeEvent
const TEXT_DELTAS = ofKind(GENERATION, 'stream_event/text_delta')

beforeEach(() => {
  // setImmediate stays real, so `flush` can still drain the microtask queue
  // while the throttle's timer is under the test's control.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date'],
    now: 1_800_000_000_000,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('acknowledging before the Task has produced anything', () => {
  it('sends the first update straight away', async () => {
    const { reporter, sent } = newReporter()

    reporter.update({ phase: 'working' })
    await flush()

    expect(sent).toEqual([{ phase: 'working' }])
  })

  // The acknowledgement is not an update; it is the message every later update
  // edits. A Channel that cannot edit still has to post it once.
  it('sends it even where nothing after it will be sent', async () => {
    const { reporter, sent } = newReporter({ updates: false })

    reporter.update({ phase: 'queued', position: 2 })
    await flush()

    expect(sent).toEqual([{ phase: 'queued', position: 2 }])
  })
})

describe('throttling what a burst of events produces', () => {
  // 194 `text_delta` events over 72 seconds, all handed over at once. A renderer
  // that edited a message per event would make 194 Channel calls for one Turn.
  it('turns a burst of events into one update', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS)

    expect(sent).toEqual([{ phase: 'working' }])

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent).toHaveLength(2)
  })

  it('sends the state as it stands when the interval comes round, not the one that armed it', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    reporter.observe(TEXT_DELTAS[1] as ClaudeEvent)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    const written = TEXT_DELTAS.slice(0, 2).map(textOf).join('')
    expect(sent.at(-1)).toEqual({ phase: 'writing', text: written })
  })

  // The 25339ms tool window: nothing arrives, so there is nothing new to say,
  // and editing the message to exactly what it already says is a wasted call.
  it('says nothing while nothing has changed', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [ASKS_FOR_A_TOOL, TOOL_STARTED])
    await vi.advanceTimersByTimeAsync(INTERVAL)
    const afterFirstUpdate = sent.length
    await vi.advanceTimersByTimeAsync(10 * INTERVAL)

    expect(sent).toHaveLength(afterFirstUpdate)
  })

  it('sends the next change as soon as the interval allows, rather than a burst later', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [])
    await vi.advanceTimersByTimeAsync(10 * INTERVAL)
    reporter.observe(TEXT_DELTAS[0] as ClaudeEvent)
    await flush()

    expect(sent).toHaveLength(2)
  })
})

describe('what an update says the Task is doing', () => {
  it('carries the prose as it is written, and everything written so far', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 3))
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({
      phase: 'writing',
      text: TEXT_DELTAS.slice(0, 3).map(textOf).join(''),
    })
  })

  // `thinking_delta` arrives with `"thinking": ""` and a token estimate. Progress
  // can say that thinking is happening and roughly how much, never what about —
  // there is nothing in the stream to say it with.
  it('says thinking is happening and how much, and never what', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [THINKING])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'thinking', estimatedTokens: 50 })
  })

  // A tool window is a stretch in which the stream says nothing at all. Naming
  // what is running is the only thing that keeps the message from going stale
  // for as long as the tool takes.
  it('names the tool that is running', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [ASKS_FOR_A_TOOL])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'tool', tool: 'Bash' })
  })

  // "Bash" is the tool; `system/task_started` carries the command itself, which
  // is what a person watching actually wants to see.
  it('prefers what Claude Code calls the running task to the tool name', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [ASKS_FOR_A_TOOL, TOOL_STARTED])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'tool', tool: expect.stringContaining('awk') })
  })

  it('stops naming a tool once its window closes', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [ASKS_FOR_A_TOOL, TOOL_STARTED])
    await vi.advanceTimersByTimeAsync(INTERVAL)
    reporter.observe(TOOL_FINISHED)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'working' })
  })

  // A background task can finish while the answer is being written, and that
  // closes no window the acknowledgement is showing. Throwing the prose away
  // for a whole interval over it would be a step backwards.
  it('keeps showing the prose when a tool finishes that it was not showing', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 2))
    await vi.advanceTimersByTimeAsync(INTERVAL)
    reporter.observe(TOOL_FINISHED)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({
      phase: 'writing',
      text: TEXT_DELTAS.slice(0, 2).map(textOf).join(''),
    })
  })

  // The complete answer arrives once more as its own `assistant` event, 85ms
  // before the terminal result. Reading it as progress too would show the whole
  // Turn's prose twice over.
  it('does not read the finished message back as more prose', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, GENERATION)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    const written = TEXT_DELTAS.map(textOf).join('')
    expect(sent.at(-1)).toEqual({ phase: 'writing', text: written })
  })
})

describe('a Channel that cannot edit a message it has posted', () => {
  // Suppression rather than periodic new messages — the choice ADR-0003 left
  // open and the Progress reporting section now records.
  it('gets the acknowledgement and nothing after it', async () => {
    const { reporter, sent } = newReporter({ updates: false })

    await acknowledgeAnd(reporter, TEXT_DELTAS)
    await vi.advanceTimersByTimeAsync(100 * INTERVAL)

    expect(sent).toEqual([{ phase: 'working' }])
  })
})

describe('a Task that is over', () => {
  it('sends nothing more once it has been stopped', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    reporter.stop()
    reporter.observe(TEXT_DELTAS[1] as ClaudeEvent)
    await vi.advanceTimersByTimeAsync(100 * INTERVAL)

    expect(sent).toEqual([{ phase: 'working' }])
  })

  // Stopping waits on nothing: a Channel that has not finished taking an update
  // must not be able to hold back the result, which is the one message roma
  // owes unconditionally.
  it('leaves nothing armed that could fire after the Task', async () => {
    const { reporter } = newReporter({ deliver: () => new Promise<void>(() => {}) })

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    expect(vi.getTimerCount()).toBe(1)

    reporter.stop()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a Channel that will not take an update', () => {
  // Progress is the one thing roma will go without. A Channel too broken to
  // carry an update is not a reason to abandon work that is running fine, and
  // the result is still owed to whoever asked for it.
  it('keeps reporting rather than failing the Task', async () => {
    const attempts: TaskProgress[] = []
    const { reporter } = newReporter({
      deliver: (progress) => {
        attempts.push(progress)
        throw new Error('the Channel is down')
      },
    })

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    await vi.advanceTimersByTimeAsync(INTERVAL)

    // Every one was attempted, and none of them threw at the Task.
    expect(attempts).toHaveLength(2)
  })

  it('keeps updates in the order they were made, however slow it is', async () => {
    const arrived: TaskProgress[] = []
    const { reporter } = newReporter({
      deliver: async (progress) => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        arrived.push(progress)
      },
    })

    reporter.update({ phase: 'queued', position: 1 })
    reporter.update({ phase: 'working' })
    await vi.advanceTimersByTimeAsync(10 * INTERVAL)

    expect(arrived).toEqual([{ phase: 'queued', position: 1 }, { phase: 'working' }])
  })
})

/** The prose one `text_delta` carries, read straight out of the capture. */
function textOf(event: ClaudeEvent): string {
  const inner = event['event'] as Record<string, unknown>
  return String((inner['delta'] as Record<string, unknown>)['text'])
}
