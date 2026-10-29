import { describe, expect, it } from 'vitest'
import { severityOf } from './compaction.js'
import { readCompaction, readCompactionFailure } from './stream-events.js'
import { ofKind, recordedStream } from '../test/support/recorded-stream.js'

/** The capture that holds a Compaction that happened, and a failed one before it. */
const AUTO = recordedStream('compaction-auto')
/** The failure on its own, provoked with the threshold under the floor. */
const FAILED = recordedStream('compaction-failed')

const SNAKE_CASE =
  'A Compaction must be read off `compact_metadata`, the snake_case the stream carries, never ' +
  "the transcript's camelCase `compactMetadata` that #98 was written against (ADR-0019, " +
  'measured in #100). A reader written from the transcript finds undefined and reports every ' +
  'Compaction as none, while looking like it works.'

describe('reading a Compaction off the stream', () => {
  it('reads the boundary the capture holds [fence:stream-compaction-snake-case]', () => {
    const [boundary] = ofKind(AUTO.events, 'system/compact_boundary')
    expect(boundary).toBeDefined()

    expect(readCompaction(boundary!), SNAKE_CASE).toEqual({
      trigger: 'auto',
      preTokens: 61486,
      postTokens: 1375,
    })
  })

  it('is not fooled by the transcript spelling [fence:stream-compaction-snake-case]', () => {
    // What #98 was written against — Claude Code's own parser, reading its
    // transcript files, where the field is `compactMetadata`. A reader written
    // from that quote finds nothing on stdout and reports every Compaction as no
    // Compaction, while looking like it works.
    const transcript = {
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'auto', pre_tokens: 61486, post_tokens: 1375 },
    } as const

    expect(readCompaction(transcript), SNAKE_CASE).toEqual({
      trigger: null,
      preTokens: null,
      postTokens: null,
    })
  })

  it('reads nothing out of the other events in the same capture', () => {
    const boundaries = AUTO.events.filter((event) => readCompaction(event) !== null)

    expect(boundaries).toHaveLength(1)
  })
})

describe('reading a failed Compaction off the stream', () => {
  it('reads the code off the status event that carries it', () => {
    const [failure] = FAILED.events.flatMap((event) => readCompactionFailure(event) ?? [])

    expect(failure).toEqual({ code: 'too_few_groups' })
  })

  it('ignores the ordinary progress the same event carries', () => {
    // `system/status` is not the Compaction's event: `requesting` and
    // `compacting` arrive on it too, and `compacting` is the one that immediately
    // precedes a failure. Only `compact_result` marks one.
    const statuses = ofKind(AUTO.events, 'system/status')
    const read = statuses.map((event) => readCompactionFailure(event))

    expect(statuses.length).toBeGreaterThan(3)
    expect(read.filter((failure) => failure !== null)).toEqual([{ code: 'too_few_groups' }])
  })

  it('does not read a success as a failure', () => {
    // The capture holds one: `compact_result: "success"` arrives just before the
    // boundary, and the boundary is what roma reads instead.
    const successes = ofKind(AUTO.events, 'system/status').filter(
      (event) => event['compact_result'] === 'success',
    )

    expect(successes).toHaveLength(1)
    expect(successes.map((event) => readCompactionFailure(event))).toEqual([null])
  })
})

describe('how seriously roma takes one', () => {
  it('says nothing about the failure both captures hold', () => {
    // Measured benign: the Turn carrying this one cost two cents and answered,
    // and the Session served the next Turn normally.
    expect(severityOf('too_few_groups')).toBe('benign')
  })

  it('says nothing about a Compaction somebody stopped', () => {
    expect(severityOf('aborted')).toBe('benign')
  })

  it('reads the two unreducible codes as a Session that is finished', () => {
    expect(severityOf('exhausted')).toBe('unreducible')
    expect(severityOf('media_unstrippable')).toBe('unreducible')
  })

  it('leaves the build own catch-all unexplained', () => {
    expect(severityOf('error')).toBe('unexplained')
  })

  it('leaves a code it has never seen unexplained rather than benign [fence:stream-unknown-compaction-code-is-unexplained]', () => {
    const why =
      'severityOf must list the codes it believes harmless and treat every other code as ' +
      'unexplained, never list the serious ones and assume the rest benign (ADR-0019). The ' +
      'other way round fails silently on the release that adds a code, which is the ' +
      '`shared-window.ts` mistake one file over: a value roma has not seen folded into the ' +
      'answer that means nothing happened.'
    expect(severityOf('some_code_a_later_release_added'), why).toBe('unexplained')
    expect(severityOf('error'), why).toBe('unexplained')
    expect(severityOf(null), why).toBe('unexplained')
  })
})
