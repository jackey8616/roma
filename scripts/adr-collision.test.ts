import { describe, expect, it } from 'vitest'
import { collisionMessage, collisionsOnMerge } from './adr-collision.js'

const BEFORE = ['0008-the-agent-clones-roma-only-mints.md', '0009-a-conversation-says-who-asked.md']

describe('the number a branch adds is checked against the tree the merge makes', () => {
  it('passes a branch taking the next free number', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: BEFORE,
        head: [...BEFORE, '0010-an-enclosure-lands-on-disk-named-by-roma.md'],
      }),
    ).toEqual([])
  })

  it('fails the branch this check was written for', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: [...BEFORE, '0010-the-acknowledgement-does-not-show-the-answer.md'],
        head: [...BEFORE, '0010-an-enclosure-lands-on-disk-named-by-roma.md'],
      }),
    ).toEqual([
      {
        number: 10,
        onBase: ['0010-the-acknowledgement-does-not-show-the-answer.md'],
        added: ['0010-an-enclosure-lands-on-disk-named-by-roma.md'],
      },
    ])
  })

  it('reads the union rather than the two trees, so a branch may rename its own ADR', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: BEFORE,
        head: [
          '0008-the-agent-clones-roma-only-mints.md',
          '0009-a-conversation-names-who-asked.md',
        ],
      }),
    ).toEqual([])
  })

  it('reads the union both ways, so the base may rename an ADR under every open branch', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: [
          '0008-the-agent-clones-roma-only-mints.md',
          '0009-a-conversation-names-who-asked.md',
        ],
        head: [...BEFORE, '0010-an-enclosure-lands-on-disk-named-by-roma.md'],
      }),
    ).toEqual([])
  })

  it('says nothing about a document both sides already have', () => {
    const both = [...BEFORE, '0010-the-acknowledgement-does-not-show-the-answer.md']

    expect(collisionsOnMerge({ mergeBase: BEFORE, base: both, head: both })).toEqual([])
  })

  it('names a number two of the branch’s own documents share, with nothing on base', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: BEFORE,
        head: [...BEFORE, '0010-the-first.md', '0010-the-second.md'],
      }),
    ).toEqual([{ number: 10, onBase: [], added: ['0010-the-first.md', '0010-the-second.md'] }])
  })

  it('keys on the number rather than the digits, so 9- and 0009- collide', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: BEFORE,
        head: [...BEFORE, '9-a-conversation-says-who-asked-again.md'],
      }),
    ).toEqual([
      {
        number: 9,
        onBase: ['0009-a-conversation-says-who-asked.md'],
        added: ['9-a-conversation-says-who-asked-again.md'],
      },
    ])
  })

  it('has no opinion about a file that is not an ADR', () => {
    expect(
      collisionsOnMerge({
        mergeBase: [...BEFORE, 'README.md'],
        base: [...BEFORE, 'README.md'],
        head: [...BEFORE, 'README.md', 'index.md'],
      }),
    ).toEqual([])
  })

  it('reports every shared number, in the order a person would look for them', () => {
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: [...BEFORE, '0010-taken.md', '0011-also-taken.md'],
        head: [...BEFORE, '0011-mine.md', '0010-mine.md'],
      }).map(({ number }) => number),
    ).toEqual([10, 11])
  })
})

describe('the failure says what to do and what it did not check', () => {
  it('names the number and both documents', () => {
    expect(message()).toContain('0010')
    expect(message()).toContain('0010-the-acknowledgement-does-not-show-the-answer.md')
    expect(message()).toContain('0010-an-enclosure-lands-on-disk-named-by-roma.md')
  })

  it('says what a shared number costs, rather than only that one exists', () => {
    expect(message()).toMatch(/resolves? to whichever document/)
  })

  it('admits in one breath that it narrows the window rather than closing it', () => {
    const admits = paragraphsOf(message()).filter(
      (paragraph) => /does not close it/.test(paragraph) && /up to date/.test(paragraph),
    )

    expect(admits).not.toEqual([])
  })

  it('names the base branch it compared against, which is the whole of what it read', () => {
    expect(collisionMessage(COLLISIONS, 'release-0.5')).toContain('release-0.5')
  })

  it('refuses to report a collision it did not find', () => {
    expect(() => collisionMessage([], 'main')).toThrow(/collision/i)
  })
})

const COLLISIONS = [
  {
    number: 10,
    onBase: ['0010-the-acknowledgement-does-not-show-the-answer.md'],
    added: ['0010-an-enclosure-lands-on-disk-named-by-roma.md'],
  },
]

function message(): string {
  return collisionMessage(COLLISIONS, 'main')
}

function paragraphsOf(body: string): string[] {
  return body.split(/\n{2,}/)
}
