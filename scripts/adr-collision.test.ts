import { describe, expect, it } from 'vitest'
import { collisionMessage, collisionsOnMerge } from './adr-collision.js'

/**
 * The question `src/adr-numbering.test.ts` cannot ask, asked away from git.
 *
 * `scripts/adr-collision.ts` carries what the union is for; what is asserted here
 * is that it is computed right, from three file lists and no `git` at all.
 *
 * Pure for the same reason the drift check is: what this most plausibly dies of is
 * its own silence. A union computed slightly wrong reports nothing and goes green,
 * and a green tick on a check named for collisions reads as "no collision". So the
 * cases below are mostly the ones where the answer is *no collision* — a branch
 * renaming its own ADR, a base renaming one under it, a document both sides
 * already have — because a check that cried wolf on any of those is a check
 * somebody switches off, and the one that matters gets one test.
 */

/** `docs/adr/` before either branch existed. */
const BEFORE = [
  '0008-the-agent-clones-roma-only-mints.md',
  '0009-a-conversation-says-who-asked.md',
]

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
    // The near-miss in #76, as it happened: the branch was cut when main held
    // 0001–0009, #72 landed `0010-the-acknowledgement…` while the second document
    // was being written, and both trees passed on their own.
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
    // Renaming a document while keeping its number is a delete and an add, and a
    // check comparing filename sets alone would call the add a collision with the
    // delete. Nothing here is renamed on merge: main gets one 0009 either way.
    //
    // This is the false positive worth spending the merge base on. A check that
    // blocks the first branch with a good reason to do something is a check that
    // gets switched off — the argument `src/adr-numbering.test.ts` makes for its
    // own narrowness.
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
    // The same rename, on the other side. Every branch cut before it still holds
    // the old filename and has deleted nothing, so a check that subtracted only
    // the branch's own deletions would fail all of them at once — on a number
    // nobody added, for a document nobody wrote.
    //
    // The worse half is that it would look like the check working. The report
    // would name two real files and one real number, and the fix it asks for —
    // renumber the document this branch adds — is not available, because this
    // branch adds none.
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
    // A branch that has already been merged once, or has the base's commit in it.
    // The union is a set of files, so one document reached by two paths is one
    // document.
    const both = [...BEFORE, '0010-the-acknowledgement-does-not-show-the-answer.md']

    expect(collisionsOnMerge({ mergeBase: BEFORE, base: both, head: both })).toEqual([])
  })

  it('names a number two of the branch’s own documents share, with nothing on base', () => {
    // `src/adr-numbering.test.ts` fails on this too, in the same run. Reported
    // anyway, because the claim this makes is about the merged tree and the merged
    // tree does hold two — and a rule with an exception carved into it for the
    // other check's benefit is a harder rule to state than the true one.
    expect(
      collisionsOnMerge({
        mergeBase: BEFORE,
        base: BEFORE,
        head: [...BEFORE, '0010-the-first.md', '0010-the-second.md'],
      }),
    ).toEqual([{ number: 10, onBase: [], added: ['0010-the-first.md', '0010-the-second.md'] }])
  })

  it('keys on the number rather than the digits, so 9- and 0009- collide', () => {
    // The same rule as `src/adr-numbering.test.ts`, for the same reason: they
    // collide here the way they would collide in a citation.
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
    // A README under `docs/adr/` is skipped rather than failed, so the directory
    // can hold one without this check having an opinion about it.
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
    // "Duplicate ADR number" reads as a naming problem, and renumbering is then a
    // chore somebody does to get the tick back. What it actually is is every
    // citation in the repo resolving to whichever document the reader had in mind.
    expect(message()).toMatch(/resolves? to whichever document/)
  })

  it('admits in one breath that it narrows the window rather than closing it', () => {
    // The sentence this half of the ticket is for. A check that looks like it
    // closes a hole and does not is worse than one that admits its limits, because
    // the next person to hit this will trust it.
    //
    // Asserted a paragraph at a time rather than over the whole message: two loose
    // `toContain`s are satisfied by a message that mentions the limit in one place
    // and branch protection somewhere else entirely, which is a reader having to
    // assemble the caveat themselves.
    const admits = paragraphsOf(message()).filter(
      (paragraph) => /does not close it/.test(paragraph) && /up to date/.test(paragraph),
    )

    expect(admits).not.toEqual([])
  })

  it('names the base branch it compared against, which is the whole of what it read', () => {
    expect(collisionMessage(COLLISIONS, 'release-0.5')).toContain('release-0.5')
  })

  it('refuses to report a collision it did not find', () => {
    // A failure message with nothing in it is a check that has started failing for
    // a reason of its own, and reads as a collision to whoever finds the red run.
    expect(() => collisionMessage([], 'main')).toThrow(/collision/i)
  })
})

/** The near-miss in #76, as the check would have reported it. */
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

/** The message as a reader takes it in: blank-line-separated blocks. */
function paragraphsOf(body: string): string[] {
  return body.split(/\n{2,}/)
}
