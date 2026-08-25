import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ledger, LedgerOptions } from '../src/index.js'
import { ledger } from '../src/index.js'

const dirs: string[] = []
const open: Ledger[] = []

/** A fresh on-disk database path that gets removed by `cleanup()`. */
export function tempDbPath(name = 'ledger.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'izi-ledger-'))
  dirs.push(dir)
  return join(dir, name)
}

export async function openLedger(options: LedgerOptions = {}): Promise<Ledger> {
  // Most tests describe a single-currency book, so they name the currency once
  // here the way a real one would. Tests about the currency rules pass their
  // own defaultCurrency, or none at all.
  const instance = await ledger({ path: ':memory:', defaultCurrency: 'BRL', ...options })
  open.push(instance)
  return instance
}

export async function cleanup(): Promise<void> {
  for (const instance of open.splice(0)) {
    await instance.close().catch(() => {})
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Raw SQLite handle on a ledger file — used to simulate tampering. */
export function raw<T>(path: string, fn: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

/** A ledger with gateway/user/fees wallets, ready for payment-shaped tests. */
export async function paymentLedger(options: LedgerOptions = {}) {
  const book = await openLedger(options)
  await book.createWallet({ id: 'gateway', allowNegative: true })
  await book.createWallet({ id: 'user:1' })
  await book.createWallet({ id: 'fees' })
  return book
}

export function payment(amount: number, fee: number) {
  return [
    { walletId: 'gateway', amount: -amount },
    { walletId: 'user:1', amount: amount - fee },
    { walletId: 'fees', amount: fee },
  ]
}
