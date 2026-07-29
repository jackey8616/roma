import { describe, expect, it } from 'vitest'
import { TaskQueue } from './task-queue.js'

const A = 'session-a'
const B = 'session-b'
const C = 'session-c'
const D = 'session-d'

/** A Task whose completion the test decides, and which records that it ran. */
function pending(): {
  readonly run: () => Promise<string>
  readonly started: () => boolean
  readonly finish: (value?: string) => void
  readonly fail: (error: Error) => void
} {
  let started = false
  let settle!: (value: string) => void
  let reject!: (error: Error) => void
  const outcome = new Promise<string>((resolve, fail) => {
    settle = resolve
    reject = fail
  })
  return {
    run: () => {
      started = true
      return outcome
    },
    started: () => started,
    finish: (value = 'done') => settle(value),
    fail: (error) => reject(error),
  }
}

/** Let everything already queued run, so admissions settle before an assertion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('serialising the Tasks of one Session', () => {
  // Forced, not chosen: two processes writing one Session file corrupt it.
  it('never runs two Tasks of one Session at the same time', async () => {
    const queue = new TaskQueue()
    const first = pending()
    const second = pending()

    const firstTask = queue.run(A, first.run)
    const secondTask = queue.run(A, second.run)
    await flush()

    expect(first.started()).toBe(true)
    expect(second.started()).toBe(false)

    first.finish()
    await firstTask
    await flush()

    expect(second.started()).toBe(true)
    second.finish()
    await secondTask
  })

  it('starts the next Task of a Session whose Task failed', async () => {
    const queue = new TaskQueue()
    const first = pending()
    const second = pending()

    const firstTask = queue.run(A, first.run)
    const secondTask = queue.run(A, second.run)
    await flush()
    first.fail(new Error('the Turn failed'))

    await expect(firstTask).rejects.toThrow('the Turn failed')
    await flush()

    expect(second.started()).toBe(true)
    second.finish()
    await secondTask
  })

  it('runs the Tasks of one Session in the order they arrived', async () => {
    const queue = new TaskQueue()
    const order: string[] = []
    const tasks = ['first', 'second', 'third'].map((name) => {
      const task = pending()
      return {
        name,
        task,
        done: queue.run(A, () => {
          order.push(name)
          return task.run()
        }),
      }
    })

    for (const { task, done } of tasks) {
      await flush()
      task.finish()
      await done
    }

    expect(order).toEqual(['first', 'second', 'third'])
  })
})

describe('the global cap', () => {
  it('runs at most three Tasks at once across every Session', async () => {
    const queue = new TaskQueue()
    const tasks = [A, B, C, D].map((key) => {
      const task = pending()
      return { key, task, done: queue.run(key, task.run) }
    })
    await flush()

    expect(tasks.map(({ task }) => task.started())).toEqual([true, true, true, false])
    expect(queue.running).toBe(3)
    expect(queue.waiting).toBe(1)

    for (const { task, done } of tasks) {
      task.finish()
      await done
      await flush()
    }
  })

  it('admits the waiting Task as soon as a slot frees', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const running = [pending(), pending()]
    const waiting = pending()
    const started = running.map(({ run }, n) => queue.run([A, B][n] ?? A, run))
    const queued = queue.run(C, waiting.run)
    await flush()

    running[0]?.finish()
    await started[0]
    await flush()

    expect(waiting.started()).toBe(true)
    running[1]?.finish()
    waiting.finish()
    await Promise.all([...started, queued])
  })

  it('takes the cap from configuration rather than assuming it', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const first = pending()
    const second = pending()

    const firstTask = queue.run(A, first.run)
    const secondTask = queue.run(B, second.run)
    await flush()

    expect(second.started()).toBe(false)
    first.finish()
    await firstTask
    await flush()
    second.finish()
    await secondTask
  })

  // One busy Conversation must not stall a Conversation that could run right
  // now. Strict head-of-line order would let a chatty thread hold the whole
  // queue behind a Session that is simply not free yet.
  it('lets a runnable Task past one waiting on its own Session', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const busy = pending()
    const behind = pending()
    const other = pending()

    const busyTask = queue.run(A, busy.run)
    const behindTask = queue.run(A, behind.run)
    const otherTask = queue.run(B, other.run)
    await flush()

    expect(behind.started()).toBe(false)
    expect(other.started()).toBe(true)

    busy.finish()
    other.finish()
    await Promise.all([busyTask, otherTask])
    await flush()
    behind.finish()
    await behindTask
  })

  it('frees the slot a failed Task held', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const first = pending()
    const second = pending()

    const firstTask = queue.run(A, first.run)
    const secondTask = queue.run(B, second.run)
    await flush()
    first.fail(new Error('the Turn failed'))
    await expect(firstTask).rejects.toThrow()
    await flush()

    expect(second.started()).toBe(true)
    expect(queue.running).toBe(1)
    second.finish()
    await secondTask
  })
})

describe('telling a waiting caller where it is', () => {
  // Unacknowledged waiting makes people resend, which compounds the backlog.
  it('tells a Task held by the cap its position', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const positions: number[] = []
    const running = pending()
    const first = pending()
    const second = pending()

    const runningTask = queue.run(A, running.run, (position) => void positions.push(position))
    const firstTask = queue.run(B, first.run, (position) => void positions.push(position))
    const secondTask = queue.run(C, second.run, (position) => void positions.push(position))
    await flush()

    expect(positions).toEqual([1, 2])

    running.finish()
    await runningTask
    await flush()
    first.finish()
    await firstTask
    await flush()
    second.finish()
    await secondTask
  })

  // Waiting on the cap and waiting on your own Conversation look the same from
  // the Conversation: nothing is happening and nobody said so.
  it('tells a Task waiting only on its own Session too', async () => {
    const queue = new TaskQueue()
    const positions: number[] = []
    const running = pending()
    const behind = pending()

    const runningTask = queue.run(A, running.run, (position) => void positions.push(position))
    const behindTask = queue.run(A, behind.run, (position) => void positions.push(position))
    await flush()

    expect(positions).toEqual([1])

    running.finish()
    await runningTask
    await flush()
    behind.finish()
    await behindTask
  })

  it('says nothing to a Task that starts straight away', async () => {
    const queue = new TaskQueue()
    const task = pending()
    let told = false

    const running = queue.run(A, task.run, () => {
      told = true
    })
    await flush()

    expect(told).toBe(false)
    task.finish()
    await running
  })

  // A Task whose caller believes nothing was received is the failure the
  // acknowledgement exists to prevent, so it is not one to run anyway.
  it('does not run a Task whose caller could not be told it was waiting', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const running = pending()
    const never = pending()

    const runningTask = queue.run(A, running.run)
    const rejected = queue.run(B, never.run, () => Promise.reject(new Error('the Channel is down')))

    await expect(rejected).rejects.toThrow('the Channel is down')
    expect(never.started()).toBe(false)
    expect(queue.waiting).toBe(0)

    running.finish()
    await runningTask
    await flush()

    expect(never.started()).toBe(false)
  })

  // The caller is told while it waits, so the queue has to give way — and a slot
  // freeing during that gap must still reach it. Nothing else comes and looks.
  it('admits a Task whose slot freed while its caller was being told', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const running = pending()
    const waiting = pending()
    let release!: () => void
    const told = new Promise<void>((resolve) => {
      release = resolve
    })

    const runningTask = queue.run(A, running.run)
    const waitingTask = queue.run(B, waiting.run, () => told)
    await flush()
    running.finish()
    await runningTask
    await flush()

    expect(waiting.started()).toBe(false)

    release()
    await flush()

    expect(waiting.started()).toBe(true)
    waiting.finish()
    await waitingTask
  })
})
