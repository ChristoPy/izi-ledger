/**
 * Bounded LRU of wallet balances.
 *
 * A write updates it after the transaction commits, so the common
 * "move money, then read the balance" sequence never touches SQLite. Every
 * entry is only ever written from inside the ledger mutex, and the whole cache
 * is dropped when another connection writes to the file (see `dataVersion` in
 * ledger.ts), which is what keeps it from serving a stale balance.
 */
export class BalanceCache {
  private readonly map = new Map<string, number>()
  readonly max: number
  hits = 0
  misses = 0
  invalidations = 0

  constructor(max: number) {
    this.max = Math.max(0, max)
  }

  get size(): number {
    return this.map.size
  }

  get(walletId: string): number | undefined {
    if (this.max === 0) return undefined
    const value = this.map.get(walletId)
    if (value === undefined) {
      this.misses++
      return undefined
    }
    // Touch for recency.
    this.map.delete(walletId)
    this.map.set(walletId, value)
    this.hits++
    return value
  }

  set(walletId: string, balance: number): void {
    if (this.max === 0) return
    this.map.delete(walletId)
    this.map.set(walletId, balance)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }

  delete(walletId: string): void {
    this.map.delete(walletId)
  }

  clear(): void {
    if (this.map.size > 0) this.invalidations++
    this.map.clear()
  }

  snapshot(): { size: number; hits: number; misses: number; invalidations: number } {
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
    }
  }
}
