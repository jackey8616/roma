import { describe, expect, it } from 'vitest'
import { TaskQueue } from './task-queue.js'

const A = 'session-a'
const B = 'session-b'
const C = 'session-c'
const D = 'session-d'

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

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('serialising the Tasks of one Session', () => {
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

  it('admits one Task, not two, into the one slot that frees [fence:queue-pump-claims-the-slot]', async () => {
    const why =
      'The slot must be claimed in #pump, at admission, never by the admitted Task once it ' +
      'starts (ADR-0003: three Tasks at once). Claimed late, every admission in one pass sees ' +
      'the same free slot, and two Tasks take the last one (#81).'
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const first = pending()
    const second = pending()
    const third = pending()
    const running = queue.run(A, first.run)
    const queued = [queue.run(B, second.run), queue.run(C, third.run)]
    await flush()

    first.finish()
    await running
    await flush()

    expect([second.started(), third.started()], why).toEqual([true, false])
    expect(queue.running, why).toBe(1)

    second.finish()
    await flush()
    third.finish()
    await Promise.all(queued)
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
  it('tells a Task held by the cap its position', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const positions: number[] = []
    const running = pending()
    const first = pending()
    const second = pending()

    const runningTask = queue.run(A, running.run, {
      notice: (position) => void positions.push(position),
    })
    const firstTask = queue.run(B, first.run, {
      notice: (position) => void positions.push(position),
    })
    const secondTask = queue.run(C, second.run, {
      notice: (position) => void positions.push(position),
    })
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

  it('tells a Task waiting only on its own Session too', async () => {
    const queue = new TaskQueue()
    const positions: number[] = []
    const running = pending()
    const behind = pending()

    const runningTask = queue.run(A, running.run, {
      notice: (position) => void positions.push(position),
    })
    const behindTask = queue.run(A, behind.run, {
      notice: (position) => void positions.push(position),
    })
    await flush()

    expect(positions).toEqual([1])

    running.finish()
    await runningTask
    await flush()
    behind.finish()
    await behindTask
  })

  it('is telling a caller the backlog, not a place in a running order [fence:queue-pump-steps-over-a-busy-session]', async () => {
    const why =
      '#pump must admit in arrival order, stepping over a Task whose Session is busy (ADR-0003). ' +
      'Strict head-of-line order lets one chatty Conversation hold every other behind a ' +
      'Session that is simply not free yet (#23).'
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const positions = new Map<string, number>()
    const order: string[] = []
    const running = { a: pending(), b: pending() }
    const held = pending()
    const free = pending()

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
    const behindA = named('behind-a', A, held.run)
    const onC = named('on-c', C, free.run)
    await flush()

    expect(positions).toEqual(
      new Map([
        ['behind-a', 1],
        ['on-c', 2],
      ]),
    )

    running.b.finish()
    await second
    await flush()

    expect(order, why).toEqual(['on-c'])

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
  const NEVER_GUESSES =
    'taskFor must answer only what is running under this key, and null otherwise (ADR-0020 §6: ' +
    'a credential request is attributed by Session, through the queue). Guessing the nearest ' +
    'Task — another Session’s, or one still waiting — puts somebody else’s name on a ' +
    'credential request in the Audit Record (#62).'

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

  it('follows the Task into the queue rather than answering early [fence:queue-task-for-never-guesses]', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const first = pending()
    const second = pending()
    const running = queue.run(A, first.run, { taskId: 'task-1' })
    const queued = queue.run(B, second.run, { taskId: 'task-2' })
    await flush()

    expect(queue.taskFor(B), NEVER_GUESSES).toBeNull()

    first.finish()
    await running
    await flush()
    expect(queue.taskFor(B), NEVER_GUESSES).toBe('task-2')

    second.finish()
    await queued
  })

  it('says nothing rather than guessing when no Task was named [fence:queue-task-for-never-guesses]', async () => {
    const queue = new TaskQueue()
    const task = pending()
    const named = pending()
    const running = queue.run(A, task.run)
    const beside = queue.run(B, named.run, { taskId: 'task-2' })
    await flush()

    expect(queue.taskFor(A), NEVER_GUESSES).toBeNull()

    task.finish()
    named.finish()
    await Promise.all([running, beside])
  })
})

describe('running a free Relay past the cap', () => {
  const UNCAPPED =
    'A free Relay must not count against the cap (ADR-0012; ADR-0003 argues the cap entirely ' +
    'in terms of model work). A free Relay drives no Turn, spends nothing and cannot storm; ' +
    'counted, three people asking what is going on stop the work they are asking about (#81).'
  const SERIALISED =
    'An uncapped entry must still wait for its own Session (ADR-0003: serialisation is forced, ' +
    'not chosen). Two processes writing one Session file corrupt it, whether or not either ' +
    'drives a Turn (#81).'
  const WALKS_PAST =
    '#pump must walk the whole waiting list, never stopping at a full cap (ADR-0012). An ' +
    'uncapped entry behind a full cap is still admissible; stopping holds every free Relay ' +
    'hostage to exactly the busy period it exists to ask about (#81).'

  it('admits an uncapped entry while the cap is full [fence:queue-free-relay-uncapped]', async () => {
    const queue = new TaskQueue({ maxConcurrent: 2 })
    const first = pending()
    const second = pending()
    const freeRelay = pending()

    const running = [queue.run(A, first.run), queue.run(B, second.run)]
    await flush()
    expect(queue.running).toBe(2)

    const relayed = queue.run(C, freeRelay.run, { uncapped: true })
    await flush()

    expect(freeRelay.started(), UNCAPPED).toBe(true)

    freeRelay.finish()
    first.finish()
    second.finish()
    await Promise.all([...running, relayed])
  })

  it('still waits for its own Session [fence:queue-relay-still-serialised]', async () => {
    const queue = new TaskQueue()
    const task = pending()
    const freeRelay = pending()

    const running = queue.run(A, task.run)
    await flush()

    const relayed = queue.run(A, freeRelay.run, { uncapped: true })
    await flush()

    expect(freeRelay.started(), SERIALISED).toBe(false)

    task.finish()
    await running
    await flush()
    expect(freeRelay.started()).toBe(true)

    freeRelay.finish()
    await relayed
  })

  it('is not counted as a Task while it runs [fence:queue-free-relay-uncapped]', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const freeRelay = pending()
    const task = pending()

    const relayed = queue.run(A, freeRelay.run, { uncapped: true })
    await flush()
    expect(queue.running, UNCAPPED).toBe(0)

    const running = queue.run(B, task.run)
    await flush()
    expect(task.started(), UNCAPPED).toBe(true)
    expect(queue.running, UNCAPPED).toBe(1)

    freeRelay.finish()
    task.finish()
    await Promise.all([relayed, running])
  })

  it('is admitted while the cap stays full throughout [fence:queue-pump-walks-past-full-cap]', async () => {
    const queue = new TaskQueue({ maxConcurrent: 1 })
    const task = pending()
    const holdingA = pending()
    const waitingOnA = pending()
    const wantsASlot = pending()

    const running = queue.run(B, task.run)
    const held = queue.run(A, holdingA.run, { uncapped: true })
    await flush()
    expect(queue.running).toBe(1)

    const waiting = queue.run(A, waitingOnA.run, { uncapped: true })
    const denied = queue.run(C, wantsASlot.run)
    await flush()
    expect(waitingOnA.started()).toBe(false)
    expect(wantsASlot.started()).toBe(false)

    holdingA.finish()
    await held
    await flush()

    expect(waitingOnA.started(), WALKS_PAST).toBe(true)
    expect(queue.running, WALKS_PAST).toBe(1)
    expect(wantsASlot.started(), WALKS_PAST).toBe(false)

    waitingOnA.finish()
    await waiting
    task.finish()
    await running
    await flush()
    wantsASlot.finish()
    await denied
  })
})
