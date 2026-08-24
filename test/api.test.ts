import { afterEach, describe, expect, test } from 'bun:test'
import defaultExport, {
  DriverUnavailableError,
  InvalidArgumentError,
  LedgerError,
  SCHEMA_VERSION,
  SchemaVersionMismatchError,
  availableDrivers,
  createLedger,
  ledger,
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
    expect((await book.listMovements({ walletId: 'fees' })).map((m) => m.amount)).toEqual([250, 100])
    expect(await book.listMovements({ idempotencyKey: 'p2' })).toHaveLength(3)
    const tx = (await book.getTransaction('p1'))!
    expect(await book.listMovements({ txId: tx.id })).toHaveLength(3)
  })

  test('supports limit, cursor and descending order', async () => {
    const book = await seeded()
    expect((await book.listMovements({ limit: 2 })).map((m) => m.seq)).toEqual([1, 2])
    expect((await book.listMovements({ afterSeq: 4 })).map((m) => m.seq)).toEqual([5, 6])
    expect((await book.listMovements({ order: 'desc', limit: 2 })).map((m) => m.seq)).toEqual([6, 5])
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
    expect(SCHEMA_VERSION).toBe(2)
  })
})
