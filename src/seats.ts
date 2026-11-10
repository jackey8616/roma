export const SEATS = 16

export const SELF_CHECK_SEAT = SEATS - 1

export const POOL_SEATS: readonly number[] = Array.from({ length: SELF_CHECK_SEAT }, (_, i) => i)

export class NoSeatLeft extends Error {
  constructor(quarantined: number) {
    super(
      `every Seat roma may lease is quarantined (${quarantined} of them), so no Session can be ` +
        'made resident until the container is restarted.',
    )
    this.name = 'NoSeatLeft'
  }
}

export class Seats {
  readonly #free: number[]
  readonly #held = new Set<number>()
  readonly #quarantined = new Set<number>()
  #waiting: { readonly take: (seat: number) => void; readonly fail: (error: Error) => void }[] = []

  constructor(seats: readonly number[]) {
    this.#free = [...seats].sort((a, b) => a - b)
  }

  get size(): number {
    return this.#free.length + this.#held.size
  }

  get quarantined(): readonly number[] {
    return [...this.#quarantined]
  }

  async lease(): Promise<number> {
    const seat = this.#free.shift()
    if (seat !== undefined) {
      this.#held.add(seat)
      return seat
    }
    if (this.#held.size === 0) throw new NoSeatLeft(this.#quarantined.size)
    return await new Promise<number>((take, fail) => this.#waiting.push({ take, fail }))
  }

  give(seat: number): void {
    if (!this.#held.delete(seat)) return
    const waiter = this.#waiting.shift()
    if (waiter === undefined) {
      this.#free.push(seat)
      this.#free.sort((a, b) => a - b)
      return
    }
    this.#held.add(seat)
    waiter.take(seat)
  }

  quarantine(seat: number): void {
    if (!this.#held.delete(seat)) return
    this.#quarantined.add(seat)
    if (this.#held.size > 0 || this.#free.length > 0) return
    const waiting = this.#waiting
    this.#waiting = []
    for (const waiter of waiting) waiter.fail(new NoSeatLeft(this.#quarantined.size))
  }
}
