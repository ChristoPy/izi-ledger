/**
 * Serialises every ledger operation through one promise chain.
 *
 * The SQLite drivers are synchronous, so a single critical section can never be
 * interleaved by the event loop — but a caller doing
 * `await Promise.all([addMovement(...), addMovement(...)])` still needs the two
 * transactions ordered, and future async work inside a section must not let a
 * second section observe a half-applied state. One queue gives both, plus a
 * deterministic, FIFO ordering of concurrent calls.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()
  private depth = 0

  /** Number of operations queued or running. */
  get pending(): number {
    return this.depth
  }

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    this.depth++
    const result = this.tail.then(fn)
    // Keep the chain alive after a rejection: the next operation must still run.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result.finally(() => {
      this.depth--
    })
  }

  /** Resolves once everything currently queued has settled. */
  drain(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined,
    )
  }
}
