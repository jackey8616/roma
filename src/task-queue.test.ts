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

    const runningTask = queue.run(A, running.run, { notice: (position) => void positions.push(position) })
    const firstTask = queue.run(B, first.run, { notice: (position) => void positions.push(position) })
    const secondTask = queue.run(C, second.run, { notice: (position) => void positions.push(position) })
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

    const runningTask = queue.run(A, running.run, { notice: (position) => void positions.push(position) })
    const behindTask = queue.run(A, behind.run, { notice: (position) => void positions.push(position) })
    await flush()

    expect(positions).toEqual([1])

    running.finish()
    await runningTask
    await flush()
    behind.finish()
    await behindTask
  })

  // The number says how much is ahead, not when this Task will run. Admission
  // steps over a Task whose Session is busy, so the one told it was first can
  // be started second — which is why nothing may schedule on this number, and
  // why an Adapter must not render it as a running order.
  it('is telling a caller the backlog, not a place in a running order', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const positions = new Map<string, number>()
    const order: string[] = []
    const running = { a: pending(), b: pending() }
    const held = pending()
    const free = pending()

    /** Run under `name`, recording the order it started in and where it queued. */
    const named = (name: string, key: string, task: () => Promise<string>): Promise<string> =>
      queue.run(
        key,
        () => {
          order.push(name)
          return task()
        },
        { notice: (position) => void positions.set(name, position) },
      )

    const first = queue.run(A, running.a.run)
    const second = queue.run(B, running.b.run)
    // Waits on its own Session, which is busy with `first`.
    const behindA = named('behind-a', A, held.run)
    // Waits only on the cap, and its own Session is free.
    const onC = named('on-c', C, free.run)
    await flush()

    expect(positions).toEqual(
      new Map([
        ['behind-a', 1],
        ['on-c', 2],
      ]),
    )

    // A slot frees, but the Session `behind-a` needs is still busy.
    running.b.finish()
    await second
    await flush()

    expect(order).toEqual(['on-c'])

    running.a.finish()
    await first
    await flush()
    held.finish()
    free.finish()
    await Promise.all([behindA, onC])

    expect(order).toEqual(['on-c', 'behind-a'])
  })

  it('says nothing to a Task that starts straight away', async () => {
    const queue = new TaskQueue()
    const task = pending()
    let told = false

    const running = queue.run(A, task.run, {
      notice: () => {
        told = true
      },
    })
    await flush()

    expect(told).toBe(false)
    task.finish()
    await running
  })

  // The queue's own answer, not a policy about Channels: a notice that threw
  // never armed the Task for admission, so leaving it in would be leaving an
  // entry that can never start and never leaves. Whether the Task deserves to
  // run regardless is the caller's call — roma's Core decides it does.
  it('drops a Task whose notice threw rather than stranding it in the queue', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const running = pending()
    const never = pending()

    const runningTask = queue.run(A, running.run)
    const rejected = queue.run(B, never.run, {
      notice: () => Promise.reject(new Error('the Channel is down')),
    })

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
    const waitingTask = queue.run(B, waiting.run, { notice: () => told })
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

describe('which Task a Session is running', () => {
  // The queue is the only thing in roma that already knows a key has exactly one
  // Task at a time — that is the serialisation rule — so asking anything else
  // would mean building a second answer that could disagree with this one.
  it('is the running one, while it runs', async () => {
    const queue = new TaskQueue()
    const task = pending()
    const running = queue.run(A, task.run, { taskId: 'task-1' })
    await flush()

    expect(queue.taskFor(A)).toBe('task-1')

    task.finish()
    await running
    expect(queue.taskFor(A)).toBeNull()
  })

  it('is nobody’s where the Session has nothing running', () => {
    expect(new TaskQueue().taskFor(A)).toBeNull()
  })

  // A Task waiting for a slot is not running, and a credential request arriving
  // from its Session belongs to whatever *is* — or to nothing.
  it('follows the Task into the queue rather than answering early', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const first = pending()
    const second = pending()
    const running = queue.run(A, first.run, { taskId: 'task-1' })
    const queued = queue.run(B, second.run, { taskId: 'task-2' })
    await flush()

    expect(queue.taskFor(B)).toBeNull()

    first.finish()
    await running
    await flush()
    expect(queue.taskFor(B)).toBe('task-2')

    second.finish()
    await queued
  })

  // Null covers a key with nothing running and a caller who named no Task, and
  // it must never guess: attributing a credential request to the nearest Task
  // would put somebody else's name on it.
  it('says nothing rather than guessing when no Task was named', async () => {
    const queue = new TaskQueue()
    const task = pending()
    const running = queue.run(A, task.run)
    await flush()

    expect(queue.taskFor(A)).toBeNull()

    task.finish()
    await running
  })
})

describe('running a Readout past the cap', () => {
  // The cap is argued entirely in terms of model work — retry storms, a bad
  // credential holding a slot for three minutes. A Readout drives no Turn, so
  // three people asking what is going on must not be able to stop the work they
  // are asking about.
  it('admits an uncapped entry while the cap is full', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const first = pending()
    const second = pending()
    const readout = pending()

    const running = [queue.run(A, first.run), queue.run(B, second.run)]
    await flush()
    expect(queue.running).toBe(2)

    const relayed = queue.run(C, readout.run, { uncapped: true })
    await flush()

    expect(readout.started()).toBe(true)

    readout.finish()
    first.finish()
    second.finish()
    await Promise.all([...running, relayed])
  })

  // Serialisation is not a choice and does not bend for a Readout: two processes
  // on one Session's transcript corrupt it, whether or not either drives a Turn.
  it('still waits for its own Session', async () => {
    const queue = new TaskQueue()
    const task = pending()
    const readout = pending()

    const running = queue.run(A, task.run)
    await flush()

    const relayed = queue.run(A, readout.run, { uncapped: true })
    await flush()

    expect(readout.started()).toBe(false)

    task.finish()
    await running
    await flush()
    expect(readout.started()).toBe(true)

    readout.finish()
    await relayed
  })

  // What the cap counts is what `running` reports, so a Readout in flight must
  // not make a Task look like it is using a slot.
  it('is not counted as a Task while it runs', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const readout = pending()
    const task = pending()

    const relayed = queue.run(A, readout.run, { uncapped: true })
    await flush()
    expect(queue.running).toBe(0)

    // And the slot it did not take is still there for real work.
    const running = queue.run(B, task.run)
    await flush()
    expect(task.started()).toBe(true)
    expect(queue.running).toBe(1)

    readout.finish()
    task.finish()
    await Promise.all([relayed, running])
  })

  // A Readout that had to wait for its Session is admitted the moment that
  // Session frees, even though the cap is still full and stays full. This is
  // what `#pump` walking its whole waiting list buys: stopping at the cap would
  // hold every Readout hostage to exactly the busy period they exist to ask
  // about.
  //
  // The Session is occupied by another Readout rather than by a Task, so that
  // freeing it releases no capped slot and the cap is provably still full when
  // the waiting one is admitted.
  it('is admitted while the cap stays full throughout', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const task = pending()
    const holdingA = pending()
    const waitingOnA = pending()
    const wantsASlot = pending()

    // The cap is full, and nothing in this test ever frees it.
    const running = queue.run(B, task.run)
    const held = queue.run(A, holdingA.run, { uncapped: true })
    await flush()
    expect(queue.running).toBe(1)

    // One Readout behind a busy Session, and one Task behind a full cap.
    const waiting = queue.run(A, waitingOnA.run, { uncapped: true })
    const denied = queue.run(C, wantsASlot.run)
    await flush()
    expect(waitingOnA.started()).toBe(false)
    expect(wantsASlot.started()).toBe(false)

    holdingA.finish()
    await held
    await flush()

    expect(waitingOnA.started()).toBe(true)
    // Still full, and the Task behind it is still waiting — the Readout was
    // admitted past the cap rather than into a slot that had come free.
    expect(queue.running).toBe(1)
    expect(wantsASlot.started()).toBe(false)

    waitingOnA.finish()
    await waiting
    task.finish()
    await running
    await flush()
    wantsASlot.finish()
    await denied
  })
})
