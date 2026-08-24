import { afterEach, describe, expect, test } from 'bun:test'
import { IdempotencyConflictError } from '../src/index.js'
import { cleanup, openLedger, payment, paymentLedger, tempDbPath } from './helpers.js'

afterEach(cleanup)

describe('idempotency', () => {
  test('replays the original transaction instead of writing twice', async () => {
    const book = await paymentLedger()
    const first = await book.addMovement(payment(10_000, 250), 'pay:1')
    const second = await book.addMovement(payment(10_000, 250), 'pay:1')

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.id).toBe(first.id)
    expect(second.timestamp).toBe(first.timestamp)
    expect(second.movements).toEqual(first.movements)
    expect(await book.getBalance('user:1')).toBe(9_750)
    expect((await book.stats()).movements).toBe(3)
  })

  test('survives a storm of concurrent retries of the same key', async () => {
    const book = await paymentLedger()
    const results = await Promise.all(
      Array.from({ length: 50 }, () => book.addMovement(payment(10_000, 250), 'pay:1')),
    )
    expect(new Set(results.map((r) => r.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(await book.getBalance('user:1')).toBe(9_750)
    expect((await book.stats()).movements).toBe(3)
  })

  test('rejects a key reused with different entries', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(10_000, 250), 'pay:1')
    await expect(book.addMovement(payment(9_000, 250), 'pay:1')).rejects.toThrow(
      IdempotencyConflictError,
    )
    expect(await book.getBalance('user:1')).toBe(9_750)
  })

  test('rejects a key reused with different transaction metadata', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(1_000, 0), { idempotencyKey: 'k', metadata: { a: 1 } })
    await expect(
      book.addMovement(payment(1_000, 0), { idempotencyKey: 'k', metadata: { a: 2 } }),
    ).rejects.toThrow(IdempotencyConflictError)
  })

  test('rejects a key reused with different entry metadata', async () => {
    const book = await paymentLedger()
    await book.addMovement(
      [
        { walletId: 'gateway', amount: -100, metadata: { ref: 'a' } },
        { walletId: 'fees', amount: 100 },
      ],
      'k',
    )
    await expect(
      book.addMovement(
        [
          { walletId: 'gateway', amount: -100, metadata: { ref: 'b' } },
          { walletId: 'fees', amount: 100 },
        ],
        'k',
      ),
    ).rejects.toThrow(IdempotencyConflictError)
  })

  test('entry order is part of the fingerprint', async () => {
    const book = await paymentLedger()
    await book.addMovement(
      [
        { walletId: 'gateway', amount: -100 },
        { walletId: 'fees', amount: 100 },
      ],
      'k',
    )
    await expect(
      book.addMovement(
        [
          { walletId: 'fees', amount: 100 },
          { walletId: 'gateway', amount: -100 },
        ],
        'k',
      ),
    ).rejects.toThrow(IdempotencyConflictError)
  })

  test('metadata key order is not part of the fingerprint', async () => {
    const book = await paymentLedger()
    const a = await book.addMovement(payment(1_000, 0), {
      idempotencyKey: 'k',
      metadata: { a: 1, b: 2 },
    })
    const b = await book.addMovement(payment(1_000, 0), {
      idempotencyKey: 'k',
      metadata: { b: 2, a: 1 },
    })
    expect(b.replayed).toBe(true)
    expect(b.id).toBe(a.id)
  })

  test('deduplicates across process restarts', async () => {
    const path = tempDbPath()
    const first = await openLedger({ path })
    await first.createWallet({ id: 'gateway', allowNegative: true })
    await first.createWallet('user:1')
    await first.createWallet('fees')
    const original = await first.addMovement(payment(10_000, 250), 'pay:1')
    await first.close()

    const second = await openLedger({ path })
    const replay = await second.addMovement(payment(10_000, 250), 'pay:1')
    expect(replay.replayed).toBe(true)
    expect(replay.id).toBe(original.id)
    expect(await second.getBalance('user:1')).toBe(9_750)
  })

  test('deduplicates against a write from another connection', async () => {
    const path = tempDbPath()
    const a = await openLedger({ path })
    await a.createWallet({ id: 'gateway', allowNegative: true })
    await a.createWallet('fees')
    const b = await openLedger({ path })

    const viaA = await a.addMovement(
      [
        { walletId: 'gateway', amount: -100 },
        { walletId: 'fees', amount: 100 },
      ],
      'shared',
    )
    const viaB = await b.addMovement(
      [
        { walletId: 'gateway', amount: -100 },
        { walletId: 'fees', amount: 100 },
      ],
      'shared',
    )
    expect(viaB.replayed).toBe(true)
    expect(viaB.id).toBe(viaA.id)
    expect(await b.getBalance('fees')).toBe(100)
  })
})

describe('getTransaction', () => {
  test('looks a transaction up by idempotency key or id', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(payment(10_000, 250), 'pay:1')
    const byKey = await book.getTransaction('pay:1')
    const byId = await book.getTransaction(tx.id)
    expect(byKey?.id).toBe(tx.id)
    expect(byId?.idempotencyKey).toBe('pay:1')
    expect(byKey?.replayed).toBe(false)
    expect(byKey?.movements).toEqual(tx.movements)
  })

  test('returns null for an unknown reference', async () => {
    const book = await paymentLedger()
    expect(await book.getTransaction('missing')).toBeNull()
  })
})
