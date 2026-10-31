import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskProgress } from './channel-adapter.js'
import { ProgressReporter, type ProgressReporterOptions } from './progress-reporter.js'
import type { ClaudeEvent } from './stream-events.js'
import { flush } from '../test/support/fake-claude.js'
import {
  COMPACTED_MANUALLY,
  GENERATING,
  ofKind,
  recordedStream,
} from '../test/support/recorded-stream.js'

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

async function acknowledgeAnd(
  reporter: ProgressReporter,
  events: readonly ClaudeEvent[],
): Promise<void> {
  reporter.update({ phase: 'working' })
  for (const event of events) reporter.observe(event)
  await flush()
}

function blocks(event: ClaudeEvent): Record<string, unknown>[] {
  const content = (event['message'] as Record<string, unknown> | undefined)?.['content']
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : []
}

const ASKS_FOR_A_TOOL = ofKind(TOOL, 'assistant').find((event) =>
  blocks(event).some((block) => block['type'] === 'tool_use'),
) as ClaudeEvent
const TOOL_STARTED = ofKind(TOOL, 'system/task_started')[0] as ClaudeEvent
const TOOL_FINISHED = ofKind(TOOL, 'system/task_notification')[0] as ClaudeEvent
const THINKING = ofKind(TOOL, 'system/thinking_tokens')[0] as ClaudeEvent
const TEXT_DELTAS = ofKind(GENERATING, 'stream_event/text_delta')

const [COMPACTING, COMPACTION_OVER] = ofKind(COMPACTED_MANUALLY, 'system/status') as [
  ClaudeEvent,
  ClaudeEvent,
]

beforeEach(() => {
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

  it('sends it even where nothing after it will be sent', async () => {
    const { reporter, sent } = newReporter({ updates: false })

    reporter.update({ phase: 'queued', position: 2 })
    await flush()

    expect(sent).toEqual([{ phase: 'queued', position: 2 }])
  })
})

describe('throttling what a burst of events produces', () => {
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
    expect(sent.at(-1)).toEqual({ phase: 'writing', characters: written.length })
  })

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
  it('carries how much has been written, summed across the deltas [fence:progress-writing-carries-no-prose]', async () => {
    const why =
      'A writing update must carry how much has been written and never the prose (ADR-0010). ' +
      'An Acknowledgement showing the prose says what the Result is about to say, seconds ' +
      'later and one message down, and the answer reads as sent twice (#72).'
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 3))
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1), why).toEqual({
      phase: 'writing',
      characters: TEXT_DELTAS.slice(0, 3).map(textOf).join('').length,
    })
  })

  it('says thinking is happening and how much, and never what', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [THINKING])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'thinking', estimatedTokens: 50 })
  })

  it('names the tool that is running', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [ASKS_FOR_A_TOOL])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'tool', tool: 'Bash' })
  })

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

  it('keeps showing the prose when a tool finishes that it was not showing [fence:progress-tool-finish-only-closes-a-tool]', async () => {
    const why =
      'A finished tool may put the Acknowledgement back to "working" only where a tool is what ' +
      'it was showing (ADR-0003, progress reporting). A background task finishing while the ' +
      'answer is being written closes no window on screen, and resetting on it throws the ' +
      'writing progress away for a whole interval.'
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 2))
    await vi.advanceTimersByTimeAsync(INTERVAL)
    reporter.observe(TOOL_FINISHED)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1), why).toEqual({
      phase: 'writing',
      characters: TEXT_DELTAS.slice(0, 2).map(textOf).join('').length,
    })
  })

  it('says a Compaction is under way, which is otherwise silence', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [COMPACTING])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1)).toEqual({ phase: 'compacting' })
  })

  it('does not read a finished Compaction as one still running [fence:stream-compacting-read-off-status]', async () => {
    const why =
      'readCompacting must read `status: "compacting"`, not the `system/status` subtype ' +
      '(ADR-0018). The same subtype carries `compact_result` with `status: null` when a ' +
      'Compaction has finished, and read off the subtype that is announced as one starting.'
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, [COMPACTION_OVER])
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(sent.at(-1), why).toEqual({ phase: 'working' })
  })

  it('does not read the finished message back as more prose', async () => {
    const { reporter, sent } = newReporter()

    await acknowledgeAnd(reporter, GENERATING)
    await vi.advanceTimersByTimeAsync(INTERVAL)

    const written = TEXT_DELTAS.map(textOf).join('')
    expect(sent.at(-1)).toEqual({ phase: 'writing', characters: written.length })
  })
})

describe('a Channel that cannot edit a message it has posted', () => {
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

  it('drops an update that was queued behind one the Channel was still taking [fence:progress-stop-waits-on-nothing]', async () => {
    const taking: (() => void)[] = []
    const handedOver: TaskProgress[] = []
    const { reporter } = newReporter({
      deliver: (progress) => {
        handedOver.push(progress)
        return new Promise<void>((release) => taking.push(release))
      },
    })

    reporter.update({ phase: 'working' })
    reporter.update({ phase: 'writing', characters: 14 })
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(handedOver).toEqual([{ phase: 'working' }])

    reporter.stop()
    for (const release of taking.splice(0)) release()
    await flush()

    expect(handedOver, STOP_WAITS_ON_NOTHING).toEqual([{ phase: 'working' }])
  })

  it('leaves nothing armed that could fire after the Task [fence:progress-stop-waits-on-nothing]', async () => {
    const { reporter } = newReporter({ deliver: () => new Promise<void>(() => {}) })

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    expect(vi.getTimerCount()).toBe(1)

    expect(reporter.stop(), STOP_WAITS_ON_NOTHING).toBeUndefined()

    expect(vi.getTimerCount(), STOP_WAITS_ON_NOTHING).toBe(0)
  })
})

const STOP_WAITS_ON_NOTHING =
  'stop() must return at once, waiting on no delivery, and must drop any update still queued ' +
  'behind one the Channel is taking (ADR-0003, Progress reporting; #58). Waiting lets a deliver that never ' +
  'settles hold the Result back forever; handing a queued update over late posts a stale ' +
  '"Working…" underneath the answer, because the Acknowledgement it would edit is gone.'

describe('a Channel that will not take an update', () => {
  it('keeps reporting rather than failing the Task [fence:progress-deliver-is-best-effort]', async () => {
    const why =
      'A rejected or throwing deliver must be swallowed (ADR-0003, Progress reporting: progress ' +
      'is the one thing roma will go without). A Channel too broken to carry an update is not a reason to ' +
      'abandon work that is running fine, and the Result is still owed to whoever asked.'
    const attempts: TaskProgress[] = []
    const { reporter } = newReporter({
      deliver: (progress) => {
        attempts.push(progress)
        throw new Error('the Channel is down')
      },
    })

    await acknowledgeAnd(reporter, TEXT_DELTAS.slice(0, 1))
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(attempts, why).toHaveLength(2)
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

function textOf(event: ClaudeEvent): string {
  const inner = event['event'] as Record<string, unknown>
  return String((inner['delta'] as Record<string, unknown>)['text'])
}
