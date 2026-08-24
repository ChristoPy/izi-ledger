import { afterEach, describe, expect, test } from 'bun:test'
import { InsufficientFundsError, LedgerClosedError, WalletAlreadyExistsError } from '../src/index.js'
import { cleanup, openLedger, payment, paymentLedger, tempDbPath } from './helpers.js'

afterEach(cleanup)

describe('serialised writes', () => {
  test('200 concurrent transactions all land, in call order, with no gaps', async () => {
    const book = await paymentLedger()
    const count = 200
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) => book.addMovement(payment(100, 10), `p${i}`)),
    )

    // The mutex is FIFO, so results come back in the order they were queued.
    expect(results.map((r) => r.movements[0]!.seq)).toEqual(
      Array.from({ length: count }, (_, i) => i * 3 + 1),
    )
    expect(await book.getBalances(['gateway', 'user:1', 'fees'])).toEqual({
      gateway: -100 * count,
      'user:1': 90 * count,
      fees: 10 * count,
    })

    const all = await book.listMovements()
    expect(all).toHaveLength(count * 3)
    expect(all.map((m) => m.seq)).toEqual(Array.from({ length: count * 3 }, (_, i) => i + 1))
    expect(new Set(all.map((m) => m.hash)).size).toBe(count * 3)
    expect((await book.verify()).ok).toBe(true)
  })

  test('concurrent writes on a file-backed ledger stay consistent', async () => {
    const book = await paymentLedger({ path: tempDbPath(), durability: 'normal' })
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => book.addMovement(payment(100, 10), `p${i}`)),
    )
    expect(await book.getBalance('fees')).toBe(1_000)
    expect((await book.verify()).ok).toBe(true)
  })

  test('reads interleaved with writes never observe a partial transaction', async () => {
    const book = await paymentLedger()
    const observed: Array<{ user: number; fees: number; gateway: number }> = []

    const writes = Array.from({ length: 100 }, (_, i) =>
      book.addMovement(payment(100, 10), `p${i}`),
    )
    const reads = Array.from({ length: 100 }, async () => {
      const balances = await book.getBalances(['gateway', 'user:1', 'fees'])
      observed.push({
        gateway: balances.gateway!,
        user: balances['user:1']!,
        fees: balances.fees!,
      })
    })
    await Promise.all([...writes, ...reads])

    expect(observed).toHaveLength(100)
    for (const snapshot of observed) {
      // Every observation is a whole number of completed transactions.
      expect(snapshot.gateway + snapshot.user + snapshot.fees).toBe(0)
      expect(snapshot.fees % 10).toBe(0)
      expect(snapshot.user).toBe(snapshot.fees * 9)
    }
  })

  test('failures in a burst do not corrupt the survivors', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(1_000, 0), 'seed')

    // Ten withdrawals of 200 against a balance of 1000: five must fail.
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        book.addMovement(
          [
            { walletId: 'user:1', amount: -200 },
            { walletId: 'fees', amount: 200 },
          ],
          `w${i}`,
        ),
      ),
    )
    const ok = settled.filter((s) => s.status === 'fulfilled')
    const failed = settled.filter((s) => s.status === 'rejected')
    expect(ok).toHaveLength(5)
    expect(failed).toHaveLength(5)
    for (const failure of failed) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError)
    }
    expect(await book.getBalance('user:1')).toBe(0)
    expect(await book.getBalance('fees')).toBe(1_000)
    expect((await book.stats()).movements).toBe(3 + 5 * 2)
    expect((await book.verify()).ok).toBe(true)
  })

  test('an error in one operation does not stall the queue', async () => {
    const book = await paymentLedger()
    const results = await Promise.allSettled([
      book.addMovement([{ walletId: 'gateway', amount: -1 }], 'bad'),
      book.addMovement(payment(100, 0), 'good'),
    ])
    expect(results[0]!.status).toBe('rejected')
    expect(results[1]!.status).toBe('fulfilled')
    expect(await book.getBalance('user:1')).toBe(100)
  })

  test('concurrent createWallet for the same id creates exactly one', async () => {
    const book = await openLedger()
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => book.createWallet('race')),
    )
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    for (const failure of settled.filter((s) => s.status === 'rejected')) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(WalletAlreadyExistsError)
    }
    expect((await book.stats()).wallets).toBe(1)
  })

  test('timestamps never move backwards, even if the clock does', async () => {
    let tick = 1_000_000
    const book = await paymentLedger({ now: () => (tick -= 1_000) })
    for (let i = 0; i < 10; i++) await book.addMovement(payment(10, 0), `p${i}`)
    const timestamps = (await book.listMovements()).map((m) => m.timestamp)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!)
    }
  })
})

describe('close', () => {
  test('waits for in-flight work before closing', async () => {
    const book = await paymentLedger()
    const write = book.addMovement(payment(1_000, 0), 'p1')
    const closing = book.close()
    await expect(write).resolves.toBeDefined()
    await closing
    expect(book.closed).toBe(true)
  })

  test('is idempotent', async () => {
    const book = await paymentLedger()
    await book.close()
    await book.close()
    expect(book.closed).toBe(true)
  })

  test('every operation rejects after close', async () => {
    const book = await paymentLedger()
    await book.close()
    await expect(book.getBalance('fees')).rejects.toThrow(LedgerClosedError)
    await expect(book.addMovement(payment(1, 0), 'k')).rejects.toThrow(LedgerClosedError)
    await expect(book.createWallet('x')).rejects.toThrow(LedgerClosedError)
    await expect(book.listMovements()).rejects.toThrow(LedgerClosedError)
    await expect(book.verify()).rejects.toThrow(LedgerClosedError)
    await expect(book.stats()).rejects.toThrow(LedgerClosedError)
  })
})
