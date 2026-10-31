import { describe, expect, it } from 'vitest'
import { ReachUse } from './reach-use.js'

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
