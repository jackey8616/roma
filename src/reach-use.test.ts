import { describe, expect, it } from 'vitest'
import { GrantUse, ReachUse } from './reach-use.js'

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

describe('waiting for a Task’s Cloud Grant requests', () => {
  it('settles at once when the Task asked for none', async () => {
    const use = new GrantUse({ wait: () => new Promise(() => {}) })

    await expect(use.settled('t')).resolves.toBeUndefined()
  })

  it('waits until every request it began has finished', async () => {
    const use = new GrantUse({ wait: () => new Promise(() => {}) })
    const first = use.begin('t')
    const second = use.begin('t')
    let settled = false
    const waiting = use.settled('t').then(() => {
      settled = true
    })

    first()
    await Promise.resolve()
    expect(settled).toBe(false)
    second()
    await waiting
    expect(settled).toBe(true)
  })

  it('stops waiting after the bound, so a hung request cannot hold a Task forever [fence:cloud-grant-wait-is-bounded]', async () => {
    let bound = 0
    const use = new GrantUse({
      settleMs: 1234,
      wait: (ms) => {
        bound = ms
        return Promise.resolve()
      },
    })
    use.begin('t')

    await use.settled('t')

    expect(
      bound,
      'A Task holds its Seat and its place in the Task Queue while it waits, so the wait for a ' +
        'grant request that never answers must end (ADR-0041 §7).',
    ).toBe(1234)
  })

  it('keeps one Task’s requests apart from another’s', async () => {
    const use = new GrantUse({ wait: () => new Promise(() => {}) })
    use.begin('other')

    await expect(use.settled('t')).resolves.toBeUndefined()
  })

  it('also waits for a request begun while it was already waiting [fence:cloud-grant-wait-takes-late-requests]', async () => {
    const use = new GrantUse({ wait: () => new Promise(() => {}) })
    const first = use.begin('t')
    let settled = false
    const waiting = use.settled('t').then(() => {
      settled = true
    })
    const second = use.begin('t')

    first()
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(
      settled,
      'A Task can begin another Cloud Grant request while its Turn waits for the first. ' +
        'Waiting only on the requests there were when the wait began loses the later grant ' +
        'from the notice and the Audit Record (ADR-0041 §7).',
    ).toBe(false)
    second()
    await waiting
    expect(settled).toBe(true)
  })

  it('keeps one deadline across every request it waits for', async () => {
    let deadlines = 0
    const use = new GrantUse({
      wait: () => {
        deadlines++
        return new Promise(() => {})
      },
    })
    const first = use.begin('t')
    const waiting = use.settled('t')
    const second = use.begin('t')
    first()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    second()
    await waiting

    expect(deadlines).toBe(1)
  })
})
