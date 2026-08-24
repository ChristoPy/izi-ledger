import { afterEach, describe, expect, test } from 'bun:test'
import {
  InsufficientFundsError,
  InvalidAmountError,
  InvalidArgumentError,
  UnbalancedMovementError,
  WalletNotFoundError,
} from '../src/index.js'
import { cleanup, openLedger, payment, paymentLedger } from './helpers.js'

afterEach(cleanup)

describe('addMovement', () => {
  test('applies a zero-sum payment across three wallets', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(payment(10_000, 250), 'pay:1')

    expect(tx.replayed).toBe(false)
    expect(tx.movements).toHaveLength(3)
    expect(await book.getBalances(['gateway', 'user:1', 'fees'])).toEqual({
      gateway: -10_000,
      'user:1': 9_750,
      fees: 250,
    })
  })

  test('records every required field on each movement', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(payment(10_000, 250), {
      idempotencyKey: 'pay:1',
      metadata: { source: 'pix' },
    })

    const [first, second, third] = tx.movements
    expect(first).toMatchObject({
      seq: 1,
      walletId: 'gateway',
      amount: -10_000,
      balance: -10_000,
      idempotencyKey: 'pay:1',
      walletSeq: 1,
      prevHash: null,
      prevWalletHash: null,
    })
    expect(first!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first!.timestamp).toBeGreaterThan(0)
    expect(second!.prevHash).toBe(first!.hash)
    expect(third!.prevHash).toBe(second!.hash)
    expect(new Set(tx.movements.map((m) => m.hash)).size).toBe(3)
    expect(tx.movements.every((m) => m.txId === tx.id)).toBe(true)
    expect(tx.metadata).toEqual({ source: 'pix' })
  })

  test('chains prevWalletHash per wallet, independent of the global chain', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(10_000, 250), 'p1')
    await book.addMovement(payment(4_000, 100), 'p2')

    const feeMovements = await book.listMovements({ walletId: 'fees' })
    expect(feeMovements.map((m) => m.walletSeq)).toEqual([1, 2])
    expect(feeMovements[0]!.prevWalletHash).toBeNull()
    expect(feeMovements[1]!.prevWalletHash).toBe(feeMovements[0]!.hash)
    // The global chain saw two other movements in between.
    expect(feeMovements[1]!.prevHash).not.toBe(feeMovements[0]!.hash)
  })

  test('stores the running balance at the time of each movement', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(10_000, 250), 'p1')
    await book.addMovement(payment(4_000, 100), 'p2')
    const fees = await book.listMovements({ walletId: 'fees' })
    expect(fees.map((m) => m.balance)).toEqual([250, 350])
  })

  test('accepts a bare string as the idempotency key', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(payment(1_000, 0), 'shorthand')
    expect(tx.idempotencyKey).toBe('shorthand')
  })

  test('distinct keys produce distinct transactions', async () => {
    const book = await paymentLedger()
    const a = await book.addMovement(payment(1_000, 0), 'a')
    const b = await book.addMovement(payment(1_000, 0), 'b')
    expect(a.id).not.toBe(b.id)
    expect(await book.getBalance('user:1')).toBe(2_000)
  })

  test('allows several entries against the same wallet', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(
      [
        { walletId: 'gateway', amount: -300 },
        { walletId: 'fees', amount: 100 },
        { walletId: 'fees', amount: 200 },
      ],
      'split',
    )
    expect(tx.movements.map((m) => m.balance)).toEqual([-300, 100, 300])
    expect(await book.getBalance('fees')).toBe(300)
  })

  test('per-entry metadata round-trips', async () => {
    const book = await paymentLedger()
    const tx = await book.addMovement(
      [
        { walletId: 'gateway', amount: -100, metadata: { z: 1, a: { b: [1, 'x', true] } } },
        { walletId: 'fees', amount: 100 },
      ],
      'meta',
    )
    expect(tx.movements[0]!.metadata).toEqual({ a: { b: [1, 'x', true] }, z: 1 })
    expect(tx.movements[1]!.metadata).toBeNull()
    const reread = await book.listMovements({ txId: tx.id })
    expect(reread[0]!.metadata).toEqual({ a: { b: [1, 'x', true] }, z: 1 })
  })
})

describe('zero-sum enforcement', () => {
  test('rejects entries that do not net to zero', async () => {
    const book = await paymentLedger()
    await expect(
      book.addMovement(
        [
          { walletId: 'gateway', amount: -10_000 },
          { walletId: 'user:1', amount: 9_000 },
        ],
        'unbalanced',
      ),
    ).rejects.toThrow(UnbalancedMovementError)
    expect((await book.stats()).movements).toBe(0)
  })

  test('reports the offending currency and delta', async () => {
    const book = await paymentLedger()
    const error = await book
      .addMovement(
        [
          { walletId: 'gateway', amount: -10_000 },
          { walletId: 'user:1', amount: 9_000 },
        ],
        'unbalanced',
      )
      .catch((e: UnbalancedMovementError) => e)
    expect(error).toBeInstanceOf(UnbalancedMovementError)
    expect((error as UnbalancedMovementError).currency).toBe('BRL')
    expect((error as UnbalancedMovementError).delta).toBe(-1_000)
  })

  test('requires each currency to balance on its own', async () => {
    const book = await openLedger()
    await book.createWallet({ id: 'brl', allowNegative: true })
    await book.createWallet({ id: 'usd', currency: 'USD', allowNegative: true })
    await expect(
      book.addMovement(
        [
          { walletId: 'brl', amount: -5_000 },
          { walletId: 'usd', amount: 1_000 },
        ],
        'mixed',
      ),
    ).rejects.toThrow(UnbalancedMovementError)
  })

  test('allows a multi-currency transaction where each side balances', async () => {
    const book = await openLedger()
    await book.createWallet({ id: 'brl:user', allowNegative: true })
    await book.createWallet({ id: 'brl:fx', allowNegative: true })
    await book.createWallet({ id: 'usd:user', currency: 'USD', allowNegative: true })
    await book.createWallet({ id: 'usd:fx', currency: 'USD', allowNegative: true })

    await book.addMovement(
      [
        { walletId: 'brl:user', amount: -5_000 },
        { walletId: 'brl:fx', amount: 5_000 },
        { walletId: 'usd:fx', amount: -1_000 },
        { walletId: 'usd:user', amount: 1_000 },
      ],
      'fx:1',
    )
    expect(await book.getBalances(['brl:user', 'usd:user'])).toEqual({
      'brl:user': -5_000,
      'usd:user': 1_000,
    })
    expect((await book.verify()).ok).toBe(true)
  })
})

describe('balance rules', () => {
  test('blocks a wallet from going negative by default', async () => {
    const book = await paymentLedger()
    await expect(
      book.addMovement(
        [
          { walletId: 'user:1', amount: -1 },
          { walletId: 'fees', amount: 1 },
        ],
        'overdraw',
      ),
    ).rejects.toThrow(InsufficientFundsError)
  })

  test('exposes the balance and attempted amount on the error', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(1_000, 0), 'seed')
    const error = await book
      .addMovement(
        [
          { walletId: 'user:1', amount: -1_500 },
          { walletId: 'fees', amount: 1_500 },
        ],
        'overdraw',
      )
      .catch((e: InsufficientFundsError) => e)
    expect(error).toBeInstanceOf(InsufficientFundsError)
    expect((error as InsufficientFundsError).walletId).toBe('user:1')
    expect((error as InsufficientFundsError).balance).toBe(1_000)
    expect((error as InsufficientFundsError).attempted).toBe(-1_500)
  })

  test('allows negative balances when the wallet opts in', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(10_000, 250), 'p1')
    expect(await book.getBalance('gateway')).toBe(-10_000)
  })

  test('a wallet may dip and recover within one transaction only if never negative', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(500, 0), 'seed')
    // -600 then +600 on user:1 — the intermediate state is negative, so it fails.
    await expect(
      book.addMovement(
        [
          { walletId: 'user:1', amount: -600 },
          { walletId: 'fees', amount: 600 },
          { walletId: 'fees', amount: -600 },
          { walletId: 'user:1', amount: 600 },
        ],
        'dip',
      ),
    ).rejects.toThrow(InsufficientFundsError)
    expect(await book.getBalance('user:1')).toBe(500)
  })
})

describe('input validation', () => {
  test('rejects malformed entry lists', async () => {
    const book = await paymentLedger()
    // @ts-expect-error runtime guard
    await expect(book.addMovement('nope', 'k')).rejects.toThrow(InvalidArgumentError)
    await expect(book.addMovement([], 'k')).rejects.toThrow(InvalidArgumentError)
    // @ts-expect-error runtime guard
    await expect(book.addMovement([null], 'k')).rejects.toThrow(InvalidArgumentError)
    // @ts-expect-error runtime guard
    await expect(book.addMovement([{ amount: 1 }], 'k')).rejects.toThrow(InvalidArgumentError)
  })

  test('rejects non-integer, unsafe and non-numeric amounts', async () => {
    const book = await paymentLedger()
    const bad = [10.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -0, '100' as unknown as number]
    for (const amount of bad) {
      await expect(
        book.addMovement(
          [
            { walletId: 'gateway', amount },
            { walletId: 'fees', amount: 0 },
          ],
          'bad-amount',
        ),
      ).rejects.toThrow(InvalidAmountError)
    }
  })

  test('rejects unknown wallets before writing anything', async () => {
    const book = await paymentLedger()
    await expect(
      book.addMovement(
        [
          { walletId: 'gateway', amount: -100 },
          { walletId: 'ghost', amount: 100 },
        ],
        'ghost',
      ),
    ).rejects.toThrow(WalletNotFoundError)
    expect((await book.stats()).movements).toBe(0)
    expect(await book.getBalance('gateway')).toBe(0)
  })

  test('requires an idempotency key', async () => {
    const book = await paymentLedger()
    await expect(book.addMovement(payment(100, 0), '')).rejects.toThrow(InvalidArgumentError)
    // @ts-expect-error the key is mandatory
    await expect(book.addMovement(payment(100, 0))).rejects.toThrow(InvalidArgumentError)
    // @ts-expect-error the key is mandatory
    await expect(book.addMovement(payment(100, 0), {})).rejects.toThrow(InvalidArgumentError)
    await expect(
      // @ts-expect-error the key must be a string
      book.addMovement(payment(100, 0), { idempotencyKey: 7 }),
    ).rejects.toThrow(InvalidArgumentError)
    expect((await book.stats()).movements).toBe(0)
  })
})
