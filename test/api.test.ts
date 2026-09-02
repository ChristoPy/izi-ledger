import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import defaultExport, {
  audit,
  availableDrivers,
  createLedger,
  DriverUnavailableError,
  InvalidArgumentError,
  LedgerError,
  LedgerNotFoundError,
  LedgerUnreadableError,
  ledger,
  ReadOnlyLedgerError,
  SCHEMA_VERSION,
  SchemaVersionMismatchError,
} from '../src/index.js'
import { cleanup, openLedger, payment, paymentLedger, raw, tempDbPath } from './helpers.js'

afterEach(cleanup)

describe('listMovements', () => {
  async function seeded() {
    const book = await paymentLedger()
    await book.addMovement(payment(10_000, 250), 'p1')
    await book.addMovement(payment(4_000, 100), 'p2')
    return book
  }

  test('returns the whole ledger in sequence order', async () => {
    const book = await seeded()
    const all = await book.listMovements()
    expect(all.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('filters by wallet, transaction and idempotency key', async () => {
    const book = await seeded()
    expect((await book.listMovements({ walletId: 'fees' })).map((m) => m.amount)).toEqual([
      250, 100,
    ])
    expect(await book.listMovements({ idempotencyKey: 'p2' })).toHaveLength(3)
    const tx = (await book.getTransaction('p1'))!
    expect(await book.listMovements({ txId: tx.id })).toHaveLength(3)
  })

  test('supports limit, cursor and descending order', async () => {
    const book = await seeded()
    expect((await book.listMovements({ limit: 2 })).map((m) => m.seq)).toEqual([1, 2])
    expect((await book.listMovements({ afterSeq: 4 })).map((m) => m.seq)).toEqual([5, 6])
    expect((await book.listMovements({ order: 'desc', limit: 2 })).map((m) => m.seq)).toEqual([
      6, 5,
    ])
  })

  test('paginates a wallet with a cursor', async () => {
    const book = await seeded()
    const page1 = await book.listMovements({ walletId: 'fees', limit: 1 })
    const page2 = await book.listMovements({
      walletId: 'fees',
      afterSeq: page1.at(-1)!.seq,
      limit: 1,
    })
    expect(page1.map((m) => m.walletSeq)).toEqual([1])
    expect(page2.map((m) => m.walletSeq)).toEqual([2])
  })

  test('returns an empty list for an unknown filter', async () => {
    const book = await seeded()
    expect(await book.listMovements({ walletId: 'ghost' })).toEqual([])
  })

  test('rejects a negative limit', async () => {
    const book = await seeded()
    await expect(book.listMovements({ limit: -1 })).rejects.toThrow(InvalidArgumentError)
  })
})

describe('stats', () => {
  test('reports counts, head and driver', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(1_000, 0), 'p1')
    const stats = await book.stats()
    expect(stats).toMatchObject({ wallets: 3, movements: 3, transactions: 1, lastSeq: 3 })
    expect(stats.headHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stats.driver).toBe('bun:sqlite')
    expect(stats.path).toBe(':memory:')
  })

  test('an empty ledger has a null head', async () => {
    const book = await openLedger()
    expect((await book.stats()).headHash).toBeNull()
    expect((await book.stats()).lastSeq).toBe(0)
  })
})

describe('module surface', () => {
  test('exports the factory under three names', () => {
    expect(defaultExport).toBe(ledger)
    expect(createLedger).toBe(ledger)
  })

  test('accepts a bare path string', async () => {
    const path = tempDbPath()
    const book = await ledger(path)
    expect((await book.stats()).path).toBe(path)
    await book.close()
  })

  test('every error carries a code and extends LedgerError', async () => {
    const book = await openLedger()
    const error = await book.getBalance('missing').catch((e) => e)
    expect(error).toBeInstanceOf(LedgerError)
    expect(error.code).toBe('WALLET_NOT_FOUND')
    expect(error.name).toBe('WalletNotFoundError')
  })

  test('lists the drivers usable in this runtime', async () => {
    const drivers = await availableDrivers()
    expect(drivers).toContain('bun:sqlite')
  })

  test('an unknown driver fails loudly', async () => {
    // @ts-expect-error deliberately invalid
    await expect(ledger({ driver: 'postgres' })).rejects.toThrow(DriverUnavailableError)
  })

  test('a driver that cannot load in this runtime reports why', async () => {
    // better-sqlite3 is a native addon that Bun cannot dlopen today.
    const error = await ledger({ driver: 'better-sqlite3' }).catch((e) => e)
    expect(error).toBeInstanceOf(DriverUnavailableError)
    expect(error.message).toContain('better-sqlite3')
  })
})

describe('schema guard', () => {
  test('refuses to open a database written by a different schema version', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet('a')
    await book.close()

    raw(path, (db) => db.run(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`))
    await expect(ledger({ path })).rejects.toThrow(SchemaVersionMismatchError)
  })

  test('exports the schema version it speaks', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })
})

/** A small, healthy ledger on disk, closed, sidecars where SQLite left them. */
async function sealed(): Promise<string> {
  const path = tempDbPath()
  const book = await openLedger({ path })
  await book.createWallet({ id: 'a', allowNegative: true })
  await book.createWallet('b')
  await book.addMovement(
    [
      { walletId: 'a', amount: -100 },
      { walletId: 'b', amount: 100 },
    ],
    'k',
  )
  await book.close()
  return path
}

describe('read-only ledgers', () => {
  test('will not create the database it was asked to read', async () => {
    const path = tempDbPath() // the directory exists, the file does not
    await expect(ledger({ path, readonly: true })).rejects.toThrow(LedgerNotFoundError)
    expect(existsSync(path)).toBe(false)
  })

  test('refuses a file that holds no ledger', async () => {
    const path = tempDbPath()
    writeFileSync(path, '')
    await expect(ledger({ path, readonly: true })).rejects.toThrow(LedgerNotFoundError)
  })

  test('reads an existing ledger', async () => {
    const path = await sealed()
    const book = await ledger({ path, readonly: true })
    expect(await book.getBalance('b')).toBe(100)
    expect((await book.verify()).ok).toBe(true)
    expect((await book.stats()).movements).toBe(2)
    await book.close()
  })

  test('refuses a WAL ledger archived without its sidecars', async () => {
    // SQLite reads through a WAL using the -shm index and a read-only handle
    // cannot create one. The main file on its own can be missing every
    // movement still in the -wal, so this has to be an error and not a report.
    const source = await sealed()
    const path = `${source}.copy`
    copyFileSync(source, path)
    const error = await ledger({ path, readonly: true }).catch((e) => e)
    expect(error).toBeInstanceOf(LedgerUnreadableError)
    expect(error.message).toContain(`${path}-wal`)
  })

  test('rejects every write path', async () => {
    const path = await sealed()
    const book = await ledger({ path, readonly: true, defaultCurrency: 'BRL' })
    await expect(book.createWallet('c')).rejects.toThrow(ReadOnlyLedgerError)
    await expect(
      book.addMovement(
        [
          { walletId: 'a', amount: -1 },
          { walletId: 'b', amount: 1 },
        ],
        'nope',
      ),
    ).rejects.toThrow(ReadOnlyLedgerError)
    await expect(book.checkpoint()).rejects.toThrow(ReadOnlyLedgerError)
    await book.close()
  })
})

describe('audit', () => {
  test('a path with no ledger is an error, not a verified empty book', async () => {
    const path = tempDbPath()
    await expect(audit({ path })).rejects.toThrow(LedgerNotFoundError)
    expect(existsSync(path)).toBe(false)
  })

  test('reports a healthy ledger', async () => {
    const path = await sealed()
    const report = await audit({ path })
    expect(report.ok).toBe(true)
    expect(report.movements).toBe(2)
    expect(report.checked).toBe(2)
    expect(report.issues).toEqual([])
    expect(report.totals).toEqual({ BRL: 0 })
  })

  test('reports a tampered ledger', async () => {
    const path = await sealed()
    raw(path, (db) => db.run('UPDATE movements SET amount = amount + 1 WHERE seq = 1'))
    const report = await audit({ path })
    expect(report.ok).toBe(false)
    expect(report.issues.length).toBeGreaterThan(0)
  })
})
