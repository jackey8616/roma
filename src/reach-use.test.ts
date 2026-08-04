import { describe, expect, it } from 'vitest'
import { ReachUse } from './reach-use.js'

/**
 * The read-and-forget half of this contract, which nothing else reaches.
 *
 * `startup.test.ts` proves the whole path — a mint over the socket turns into a
 * yes on the Audit Record — but it proves it once per Task, so a `takeUsedBy`
 * that stopped deleting would leave every one of those tests green. What it
 * would leave behind is a Set holding every Task that ever minted, growing for
 * the life of the process, and the answer to a Task's second Audit Record would
 * become a token the first one had already accounted for.
 */
describe('a Reach’s use is remembered until it is written down', () => {
  it('answers yes once and no after that', () => {
    const use = new ReachUse()
    use.minted('task-1')

    expect(use.takeUsedBy('task-1')).toBe(true)
    expect(use.takeUsedBy('task-1')).toBe(false)
  })

  it('answers no for a Task that never minted', () => {
    expect(new ReachUse().takeUsedBy('task-1')).toBe(false)
  })
})
